// __EXAMPLE__ — off-chain flow (scaffolded skeleton).
//
// This file is intentionally STANDALONE and copy-paste friendly: the
// boilerplate frame (blueprint loading, yaci config) lives here, not in a
// shared library. Fill in the TODOs with idiomatic Apollo code, then remove
// the final error return. See docs/ADDING-A-LIBRARY.md for the contract.
//
// For the transaction-building helpers this skeleton doesn't include
// (applyParam, scriptAddress, submitAndConfirm, waitForTx, waitForUtxos —
// including the CBOR-wrapped-flat-UPLC requirement for common.PlutusV3Script),
// copy the frame from simple-transfer/offchain/apollo/simple_transfer.go.
//
// Run `go mod tidy` in this directory before `go run .` — Go builds default
// to -mod=readonly, so a go.sum matching this module's dependencies must
// exist first.
package main

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	apollo "github.com/Salvionied/apollo/v2"
	"github.com/Salvionied/apollo/v2/backend/blockfrost"
	"github.com/blinklabs-io/bursa"
)

const (
	// yaci-devkit exposes a Blockfrost-compatible API here.
	yaciAPI = "http://localhost:8080/api/v1"

	// yaci-devkit's default network is magic 42, which gouroboros names
	// "devnet". It carries network id 0 (testnet-class addresses).
	// NOTE: "testnet" is NOT a valid gouroboros network name.
	networkName = "devnet"
	networkID   = uint8(0)

	mnemonic = "test test test test test test test test test test test test " +
		"test test test test test test test test test test test sauce"

	// TODO: match your validator's title in plutus.json.
	validatorTitle = "__EXAMPLE__.__EXAMPLE__.spend"
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
// blueprint that lists its validators in a different order cannot silently
// break the cross-check. Falls back to the first entry.
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

func wallet(account uint32) (*apollo.BursaWallet, error) {
	return apollo.NewBursaWallet(
		mnemonic,
		bursa.WithNetwork(networkName),
		bursa.WithAccountID(account),
	)
}

func run() error {
	v, err := loadValidator(validatorTitle)
	if err != nil {
		return err
	}
	code, err := hex.DecodeString(v.CompiledCode)
	if err != nil {
		return fmt.Errorf("decode compiledCode: %w", err)
	}
	fmt.Printf("=== __EXAMPLE__ scenario (scaffold) ===\n")
	fmt.Printf("Loaded validator %q (%d bytes)\n", v.Title, len(code))

	cc := blockfrost.NewBlockFrostChainContext(yaciAPI, networkID, "Dummy Key")
	w, err := wallet(0)
	if err != nil {
		return fmt.Errorf("derive wallet: %w", err)
	}
	a := apollo.New(cc).SetWallet(w)
	_ = a

	// TODO: build → submit → confirm the use-case transaction(s).
	return errors.New("__EXAMPLE__ off-chain flow not implemented yet")
}

func main() {
	// Exit non-zero on any failure so the cross-check marks this combo red.
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "FAILED: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("=== Scenario complete ===")
}
