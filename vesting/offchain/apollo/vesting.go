// vesting — Apollo v2 (Go) off-chain flow.
//
// Demonstrates the two vesting paths:
//  1. Owner clawback — owner reclaims before the deadline.
//  2. Beneficiary claim — beneficiary collects after the deadline.
//
// Accounts use the shared 24-word test mnemonic; account 0 = owner/funder,
// account 1 = beneficiary.
//
// Run against a local yaci-devkit instance:
//
//	go run .
package main

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"time"

	apollo "github.com/Salvionied/apollo/v2"
	"github.com/Salvionied/apollo/v2/backend/blockfrost"
	"github.com/Salvionied/apollo/v2/plutusencoder"
	"github.com/blinklabs-io/bursa"
	"github.com/blinklabs-io/gouroboros/ledger/common"
	"github.com/blinklabs-io/plutigo/data"
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

	validatorTitle = "vesting.vesting.spend"

	depositAmount = int64(5_000_000)
	fundAmount    = int64(20_000_000)
)

// VestingDatum mirrors the Aiken VestingDatum constructor:
//
//	pub type VestingDatum {
//	  lock_until: Int,      // POSIX milliseconds
//	  owner: ByteArray,
//	  beneficiary: ByteArray,
//	}
//
// plutusConstr:"0" produces CBOR tag 121 (constructor 0) and DefList gives the
// three fields as a definite-length array — d87983 <int> <bytes> <bytes>.
type VestingDatum struct {
	_           struct{} `plutusType:"DefList" plutusConstr:"0"`
	LockUntil   int64    `plutusType:"Int"`
	Owner       []byte   `plutusType:"Bytes"`
	Beneficiary []byte   `plutusType:"Bytes"`
}

// slotConfig returns (zeroTimeMs, zeroSlot, slotLengthMs) for yaci-devkit.
//
// The chain's genesis zero-time is computed from the latest block header as
// zeroTime = block.time - block.slot. This is the value ogmios uses for
// slot↔POSIX conversion, so it must match exactly or the validator's
// valid_after check will appear to be off by an era offset.
func slotConfig() (int64, int64, int64, error) {
	resp, err := http.Get(yaciAPI + "/blocks/latest")
	if err != nil {
		return 0, 0, 0, fmt.Errorf("fetch latest block: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return 0, 0, 0, fmt.Errorf("fetch latest block: unexpected status %s", resp.Status)
	}
	var b struct {
		Time int64 `json:"time"`
		Slot int64 `json:"slot"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&b); err != nil {
		return 0, 0, 0, fmt.Errorf("decode latest block: %w", err)
	}
	// A 200 response with a body that doesn't match the expected shape (e.g.
	// {} or a Blockfrost-style error object) decodes silently into zero
	// values. Reject that rather than trusting a zero-time genesis, which
	// would make every lock_until pass valid_after trivially and turn the
	// scenario into a false-positive green run.
	if b.Time <= 0 || b.Time <= b.Slot {
		return 0, 0, 0, fmt.Errorf("implausible block header: time=%d slot=%d", b.Time, b.Slot)
	}
	return (b.Time - b.Slot) * 1000, 0, 1000, nil
}

func slotToMs(slot, zeroTimeMs, zeroSlot, slotLenMs int64) int64 {
	return zeroTimeMs + (slot-zeroSlot)*slotLenMs
}

// datumFor encodes a VestingDatum as an inline Plutus datum.
func datumFor(d VestingDatum) (*common.Datum, error) {
	pd, err := plutusencoder.MarshalPlutus(&d)
	if err != nil {
		return nil, fmt.Errorf("marshal datum: %w", err)
	}
	return &common.Datum{Data: pd}, nil
}

// ---------------------------------------------------------------------------
// Helpers — copied verbatim from simple-transfer/offchain/apollo/simple_transfer.go
// (only validatorTitle above differs). Entry files are standalone per
// docs/ADDING-A-LIBRARY.md: the boilerplate frame is written into each file,
// not imported from a shared package.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// End of copied helpers.
// ---------------------------------------------------------------------------

func run() error {
	fmt.Println("=== vesting scenario: fund → deposit×2 → owner-withdraw → wait → beneficiary-withdraw ===")

	v, err := loadValidator(validatorTitle)
	if err != nil {
		return err
	}
	fmt.Printf("Loaded validator %q\n", v.Title)

	// This validator takes no parameters, so the blueprint's compiledCode is
	// used as-is. It is already CBOR-wrapped flat UPLC, which is exactly what
	// common.PlutusV3Script must hold.
	scriptBytes, err := hex.DecodeString(v.CompiledCode)
	if err != nil {
		return fmt.Errorf("decode compiledCode: %w", err)
	}
	script := common.PlutusV3Script(scriptBytes)
	sAddr, err := scriptAddress(script)
	if err != nil {
		return fmt.Errorf("script address: %w", err)
	}
	fmt.Printf("Vesting script address: %s\n", sAddr.String())

	cc := blockfrost.NewBlockFrostChainContext(yaciAPI, networkID, "Dummy Key")

	owner, err := wallet(0)
	if err != nil {
		return fmt.Errorf("derive owner: %w", err)
	}
	beneficiary, err := wallet(1)
	if err != nil {
		return fmt.Errorf("derive beneficiary: %w", err)
	}
	fmt.Printf("Owner       (account 0): %s\n", owner.Address().String())
	fmt.Printf("Beneficiary (account 1): %s\n", beneficiary.Address().String())

	zeroTimeMs, zeroSlot, slotLenMs, err := slotConfig()
	if err != nil {
		return err
	}
	fmt.Printf("Slot config: zeroTimeMs=%d zeroSlot=%d slotLenMs=%d\n", zeroTimeMs, zeroSlot, slotLenMs)

	ownerPKH := owner.PubKeyHash().Bytes()
	benefPKH := beneficiary.PubKeyHash().Bytes()

	// Step 1: fund the beneficiary so it can cover collateral.
	fmt.Printf("Funding beneficiary with %d lovelace ...\n", fundAmount)
	ownerUtxos, err := cc.Utxos(owner.Address())
	if err != nil {
		return fmt.Errorf("load owner utxos: %w", err)
	}
	fundTx := apollo.New(cc).SetWallet(owner).
		AddLoadedUTxOs(ownerUtxos...).
		PayToAddress(beneficiary.Address(), fundAmount)
	if _, err := submitAndConfirm(cc, fundTx, beneficiary.Address(), "FUND"); err != nil {
		return err
	}

	// Step 2: deposit for the owner-clawback path, deadline ~1 hour out.
	clawbackLockMs := time.Now().UnixMilli() + 3_600_000
	clawbackDatum, err := datumFor(VestingDatum{
		LockUntil:   clawbackLockMs,
		Owner:       ownerPKH,
		Beneficiary: benefPKH,
	})
	if err != nil {
		return err
	}
	fmt.Printf("Depositing %d lovelace for owner clawback (lock_until=%d) ...\n", depositAmount, clawbackLockMs)
	ownerUtxos, err = cc.Utxos(owner.Address())
	if err != nil {
		return fmt.Errorf("reload owner utxos: %w", err)
	}
	clawbackTx := apollo.New(cc).SetWallet(owner).
		AddLoadedUTxOs(ownerUtxos...).
		PayToContract(sAddr, clawbackDatum, depositAmount)
	clawbackID, err := submitAndConfirm(cc, clawbackTx, sAddr, "DEPOSIT_OWNER")
	if err != nil {
		return err
	}

	// Step 3: deposit for the beneficiary-claim path, deadline ~10 slots out.
	tipSlot, err := cc.Tip()
	if err != nil {
		return fmt.Errorf("fetch tip: %w", err)
	}
	benefLockSlot := int64(tipSlot) + 10
	benefLockMs := slotToMs(benefLockSlot, zeroTimeMs, zeroSlot, slotLenMs)
	benefDatum, err := datumFor(VestingDatum{
		LockUntil:   benefLockMs,
		Owner:       ownerPKH,
		Beneficiary: benefPKH,
	})
	if err != nil {
		return err
	}
	fmt.Printf("Depositing %d lovelace for beneficiary claim (lock_until slot=%d ms=%d) ...\n",
		depositAmount, benefLockSlot, benefLockMs)
	ownerUtxos, err = cc.Utxos(owner.Address())
	if err != nil {
		return fmt.Errorf("reload owner utxos: %w", err)
	}
	benefTx := apollo.New(cc).SetWallet(owner).
		AddLoadedUTxOs(ownerUtxos...).
		PayToContract(sAddr, benefDatum, depositAmount)
	benefID, err := submitAndConfirm(cc, benefTx, sAddr, "DEPOSIT_BENEF")
	if err != nil {
		return err
	}

	// Step 4: owner reclaims the first deposit. The validator's clawback path
	// is unconditional apart from the owner's signature.
	if _, err := waitForUtxos(cc, sAddr, 2); err != nil {
		return err
	}
	fmt.Println("Owner reclaiming the clawback deposit ...")
	clawbackUtxo, err := utxoFromTx(cc, sAddr, clawbackID)
	if err != nil {
		return err
	}
	ownerUtxos, err = cc.Utxos(owner.Address())
	if err != nil {
		return fmt.Errorf("reload owner utxos: %w", err)
	}
	withdrawTx := apollo.New(cc).SetWallet(owner).
		AddLoadedUTxOs(ownerUtxos...).
		CollectFrom(*clawbackUtxo, common.Datum{Data: data.NewConstr(0)}, common.ExUnits{}).
		AttachScript(script).
		AddRequiredSignerPaymentKey(owner.Address())
	if _, err := submitAndConfirm(cc, withdrawTx, owner.Address(), "OWNER_WITHDRAW"); err != nil {
		return err
	}

	// Step 5: wait for the tip to pass the beneficiary deadline.
	//
	// Bounded like every other wait in this file: an unreachable node already
	// returns an error immediately below, but a node that stays reachable and
	// simply stops producing blocks must not spin forever.
	startTip, err := cc.Tip()
	if err != nil {
		return fmt.Errorf("fetch tip: %w", err)
	}
	fmt.Printf("Waiting for tip to pass slot %d (currently %d) ...\n", benefLockSlot, startTip)
	waitStart := time.Now()
	passed := false
	for range 300 {
		tip, err := cc.Tip()
		if err != nil {
			return fmt.Errorf("fetch tip: %w", err)
		}
		if int64(tip) > benefLockSlot {
			// Report how much was actually waited, not just that the loop
			// exited: confirming DEPOSIT_BENEF and OWNER_WITHDRAW usually
			// already consumes more than the ~10-slot margin, so this wait is
			// frequently zero-length — that should be visible, not implied.
			fmt.Printf("  Tip is now %d, past deadline slot %d (waited %d slot(s), %s).\n",
				tip, benefLockSlot, int64(tip)-int64(startTip), time.Since(waitStart).Round(time.Second))
			passed = true
			break
		}
		time.Sleep(time.Second)
	}
	if !passed {
		return fmt.Errorf("tip did not pass slot %d within 300s", benefLockSlot)
	}

	// Step 6: beneficiary claims. The validator requires both the
	// beneficiary's signature and valid_after(validity_range, lock_until), so
	// validity_start must be strictly after the deadline slot.
	fmt.Println("Beneficiary claiming the vested deposit ...")
	benefUtxo, err := utxoFromTx(cc, sAddr, benefID)
	if err != nil {
		return err
	}
	tip, err := cc.Tip()
	if err != nil {
		return fmt.Errorf("fetch tip: %w", err)
	}
	validityStart := benefLockSlot + 1
	if int64(tip)-5 > validityStart {
		validityStart = int64(tip) - 5
	}
	benefUtxos, err := cc.Utxos(beneficiary.Address())
	if err != nil {
		return fmt.Errorf("load beneficiary utxos: %w", err)
	}
	claimTx := apollo.New(cc).SetWallet(beneficiary).
		AddLoadedUTxOs(benefUtxos...).
		CollectFrom(*benefUtxo, common.Datum{Data: data.NewConstr(0)}, common.ExUnits{}).
		AttachScript(script).
		AddRequiredSignerPaymentKey(beneficiary.Address()).
		SetValidityStart(validityStart).
		SetTtl(validityStart + 120)
	if _, err := submitAndConfirm(cc, claimTx, beneficiary.Address(), "BENEFICIARY_WITHDRAW"); err != nil {
		return err
	}

	return nil
}

// utxoFromTx polls until the UTxO produced by txID is visible at addr,
// mirroring waitForTx's polling loop (same 90s bound) but returning the UTxO
// itself instead of just confirming its presence. The match must happen
// inside the loop: waitForUtxos(addr, 1) would return on the first poll that
// sees *any* UTxO at addr, which is not necessarily the one from txID.
func utxoFromTx(
	cc *blockfrost.BlockFrostChainContext,
	addr common.Address,
	txID common.Blake2b256,
) (*common.Utxo, error) {
	for range 90 {
		utxos, err := cc.Utxos(addr)
		if err == nil {
			for i := range utxos {
				if utxos[i].Id.Id() == txID {
					return &utxos[i], nil
				}
			}
		}
		time.Sleep(time.Second)
	}
	return nil, fmt.Errorf("utxo from tx %s not found at %s within 90s", txID.String(), addr.String())
}

func main() {
	// Exit non-zero on any failure so the cross-check marks this combo red.
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "FAILED: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("=== Scenario complete ===")
}
