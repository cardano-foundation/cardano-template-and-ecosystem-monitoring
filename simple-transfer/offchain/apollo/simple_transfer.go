// simple-transfer — Apollo v2 (Go) off-chain flow.
//
// Locks 10 ADA at a parameterised PlutusV3 script (the recipient's key hash is
// baked into the script hash, so each recipient gets a distinct address), then
// claims it with the recipient's signature.
//
// Accounts use the shared 24-word test mnemonic; account 0 = funder/sender,
// account 1 = recipient.
//
// Apollo v2 has no ApplyParamsToScript, so parameter application is done here
// with plutigo's UPLC codec: decode the flat program, wrap its term in an
// Apply node carrying the parameter as a Data constant, re-encode. This
// reproduces `aiken blueprint apply` byte for byte.
//
// Run against a local yaci-devkit instance:
//
//	go run .
package main

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	apollo "github.com/Salvionied/apollo/v2"
	"github.com/Salvionied/apollo/v2/backend/blockfrost"
	"github.com/blinklabs-io/bursa"
	"github.com/blinklabs-io/gouroboros/ledger/common"
	"github.com/blinklabs-io/plutigo/data"
	"github.com/blinklabs-io/plutigo/syn"
	"github.com/fxamacker/cbor/v2"
)

const (
	// yaci-devkit exposes a Blockfrost-compatible API here. Apollo's
	// Blockfrost backend accepts any 2xx, so yaci's HTTP 202 responses to
	// submit and evaluate need no special handling.
	yaciAPI = "http://localhost:8080/api/v1"

	// yaci-devkit's default network is magic 42, which gouroboros names
	// "devnet"; it carries network id 0 (testnet-class addresses).
	// "testnet" is NOT a valid gouroboros network name.
	networkName = "devnet"
	networkID   = uint8(0)

	mnemonic = "test test test test test test test test test test test test " +
		"test test test test test test test test test test test sauce"

	validatorTitle = "simple_transfer.simpleTransfer.spend"

	lockAmount = int64(10_000_000)
	fundAmount = int64(20_000_000)
)

type blueprint struct {
	Validators []blueprintValidator `json:"validators"`
}

type blueprintValidator struct {
	Title        string `json:"title"`
	CompiledCode string `json:"compiledCode"`
	Hash         string `json:"hash"`
}

// blueprintPath honours PLUTUS_JSON so the cross-check runner can point this
// same flow at any on-chain blueprint (aiken, scalus, …) without code edits.
func blueprintPath() string {
	if p := os.Getenv("PLUTUS_JSON"); p != "" {
		return p
	}
	return filepath.Join("..", "..", "onchain", "aiken", "plutus.json")
}

// loadValidator looks the validator up BY TITLE, not by array index, so a
// blueprint listing its validators in a different order cannot silently break
// the cross-check. Falls back to the first entry.
func loadValidator(title string) (blueprintValidator, error) {
	raw, err := os.ReadFile(blueprintPath())
	if err != nil {
		return blueprintValidator{}, fmt.Errorf("read blueprint: %w", err)
	}
	var bp blueprint
	if err := json.Unmarshal(raw, &bp); err != nil {
		return blueprintValidator{}, fmt.Errorf("parse blueprint: %w", err)
	}
	for _, v := range bp.Validators {
		if v.Title == title {
			return v, nil
		}
	}
	if len(bp.Validators) > 0 {
		return bp.Validators[0], nil
	}
	return blueprintValidator{}, fmt.Errorf("validator not found: %s", title)
}

// applyParam applies a single parameter to a parameterised validator.
// compiledCode is the blueprint's flat UPLC wrapped in one CBOR bytestring;
// the result is re-wrapped the same way, because common.PlutusV3Script must
// hold the CBOR-wrapped form to hash correctly.
func applyParam(compiledCode string, param data.PlutusData) (common.PlutusV3Script, error) {
	wrapped, err := hex.DecodeString(compiledCode)
	if err != nil {
		return nil, fmt.Errorf("decode compiledCode: %w", err)
	}
	var flat []byte
	if err := cbor.Unmarshal(wrapped, &flat); err != nil {
		return nil, fmt.Errorf("unwrap compiledCode: %w", err)
	}
	prog, err := syn.DecodeDeBruijn(flat)
	if err != nil {
		return nil, fmt.Errorf("decode uplc: %w", err)
	}
	appliedFlat, err := syn.Encode(&syn.Program[syn.DeBruijn]{
		Version: prog.Version,
		Term: &syn.Apply[syn.DeBruijn]{
			Function: prog.Term,
			Argument: &syn.Constant{Con: &syn.Data{Inner: param}},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("encode uplc: %w", err)
	}
	rewrapped, err := cbor.Marshal(appliedFlat)
	if err != nil {
		return nil, fmt.Errorf("rewrap script: %w", err)
	}
	return common.PlutusV3Script(rewrapped), nil
}

// scriptAddress builds the enterprise (no-staking) script address.
func scriptAddress(script common.PlutusV3Script) (common.Address, error) {
	return common.NewAddressFromParts(
		common.AddressTypeScriptNone,
		common.AddressNetworkTestnet,
		script.Hash().Bytes(),
		nil,
	)
}

func wallet(account uint32) (*apollo.BursaWallet, error) {
	// SetWalletFromMnemonic is unusable here: it defaults to mainnet, and
	// Apollo v2 rejects cross-network transactions at Complete().
	return apollo.NewBursaWallet(
		mnemonic,
		bursa.WithNetwork(networkName),
		bursa.WithAccountID(account),
	)
}

// submitAndConfirm completes, signs and submits the transaction, then waits for
// an output of it to appear at watch.
func submitAndConfirm(
	cc *blockfrost.BlockFrostChainContext,
	a *apollo.Apollo,
	watch common.Address,
	label string,
) (common.Blake2b256, error) {
	var zero common.Blake2b256
	built, err := a.Complete()
	if err != nil {
		return zero, fmt.Errorf("%s: complete: %w", label, err)
	}
	signed, err := built.Sign()
	if err != nil {
		return zero, fmt.Errorf("%s: sign: %w", label, err)
	}
	txID, err := signed.Submit()
	if err != nil {
		return zero, fmt.Errorf("%s: submit: %w", label, err)
	}
	fmt.Printf("  Submitted %s: tx=%s\n", label, txID.String())
	if err := waitForTx(cc, watch, txID); err != nil {
		return zero, fmt.Errorf("%s: %w", label, err)
	}
	return txID, nil
}

// waitForTx polls until an output of txID is visible at addr.
func waitForTx(
	cc *blockfrost.BlockFrostChainContext,
	addr common.Address,
	txID common.Blake2b256,
) error {
	for range 90 {
		utxos, err := cc.Utxos(addr)
		if err == nil {
			for _, u := range utxos {
				if u.Id.Id() == txID {
					return nil
				}
			}
		}
		time.Sleep(time.Second)
	}
	return fmt.Errorf("tx %s not confirmed at %s within 90s", txID.String(), addr.String())
}

// waitForUtxos polls until at least min UTxOs are visible at addr.
func waitForUtxos(
	cc *blockfrost.BlockFrostChainContext,
	addr common.Address,
	min int,
) ([]common.Utxo, error) {
	for range 90 {
		utxos, err := cc.Utxos(addr)
		if err == nil && len(utxos) >= min {
			return utxos, nil
		}
		time.Sleep(time.Second)
	}
	return nil, fmt.Errorf("timed out waiting for >=%d utxo(s) at %s", min, addr.String())
}

func run() error {
	fmt.Println("=== simple-transfer scenario: fund → lock → claim ===")

	v, err := loadValidator(validatorTitle)
	if err != nil {
		return err
	}
	fmt.Printf("Loaded validator %q\n", v.Title)

	cc := blockfrost.NewBlockFrostChainContext(yaciAPI, networkID, "Dummy Key")

	sender, err := wallet(0)
	if err != nil {
		return fmt.Errorf("derive sender: %w", err)
	}
	recipient, err := wallet(1)
	if err != nil {
		return fmt.Errorf("derive recipient: %w", err)
	}
	fmt.Printf("Sender    (account 0): %s\n", sender.Address().String())
	fmt.Printf("Recipient (account 1): %s\n", recipient.Address().String())

	// The recipient's payment key hash is the script parameter.
	script, err := applyParam(v.CompiledCode, data.NewByteString(recipient.PubKeyHash().Bytes()))
	if err != nil {
		return err
	}
	sAddr, err := scriptAddress(script)
	if err != nil {
		return fmt.Errorf("script address: %w", err)
	}
	fmt.Printf("Script address: %s\n", sAddr.String())

	// Step 1: fund the recipient so it can cover collateral when claiming.
	fmt.Printf("Funding recipient with %d lovelace ...\n", fundAmount)
	senderUtxos, err := cc.Utxos(sender.Address())
	if err != nil {
		return fmt.Errorf("load sender utxos: %w", err)
	}
	fundTx := apollo.New(cc).SetWallet(sender).
		AddLoadedUTxOs(senderUtxos...).
		PayToAddress(recipient.Address(), fundAmount)
	if _, err := submitAndConfirm(cc, fundTx, recipient.Address(), "FUND"); err != nil {
		return err
	}

	// Step 2: lock funds at the parameterised script.
	fmt.Printf("Locking %d lovelace at the script ...\n", lockAmount)
	senderUtxos, err = cc.Utxos(sender.Address())
	if err != nil {
		return fmt.Errorf("reload sender utxos: %w", err)
	}
	lockTx := apollo.New(cc).SetWallet(sender).
		AddLoadedUTxOs(senderUtxos...).
		PayToContract(sAddr, nil, lockAmount)
	lockID, err := submitAndConfirm(cc, lockTx, sAddr, "LOCK")
	if err != nil {
		return err
	}

	// Step 3: claim as the recipient. The validator checks
	// key_signed(tx.extra_signatories, receiver), so the recipient's payment
	// key must be an explicit required signer.
	fmt.Println("Claiming from the script as the recipient ...")
	scriptUtxos, err := waitForUtxos(cc, sAddr, 1)
	if err != nil {
		return err
	}
	var target *common.Utxo
	for i := range scriptUtxos {
		if scriptUtxos[i].Id.Id() == lockID {
			target = &scriptUtxos[i]
			break
		}
	}
	if target == nil {
		return fmt.Errorf("locked utxo from tx %s not found at %s", lockID.String(), sAddr.String())
	}
	recipientUtxos, err := cc.Utxos(recipient.Address())
	if err != nil {
		return fmt.Errorf("load recipient utxos: %w", err)
	}
	claimTx := apollo.New(cc).SetWallet(recipient).
		AddLoadedUTxOs(recipientUtxos...).
		CollectFrom(*target, common.Datum{Data: data.NewConstr(0)}, common.ExUnits{}).
		AttachScript(script).
		AddRequiredSignerPaymentKey(recipient.Address())
	if _, err := submitAndConfirm(cc, claimTx, recipient.Address(), "CLAIM"); err != nil {
		return err
	}

	return nil
}

func main() {
	// Exit non-zero on any failure so the cross-check marks this combo red.
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "FAILED: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("=== Scenario complete ===")
}
