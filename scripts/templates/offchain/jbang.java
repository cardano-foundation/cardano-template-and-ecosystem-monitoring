///usr/bin/env jbang "$0" "$@" ; exit $?
// @formatter:off
//JAVA 24+
//DEPS com.bloxbean.cardano:cardano-client-lib:0.8.0-pre4
//DEPS com.bloxbean.cardano:cardano-client-backend-blockfrost:0.8.0-pre4
// @formatter:on

// __CLASS__ — off-chain flow (scaffolded skeleton).
//
// This file is intentionally STANDALONE and copy-paste friendly: the boilerplate
// frame (blueprint loading, yaci config) lives here, not in a shared library.
// Fill in the TODOs with your SDK's idiomatic transaction-building code, then
// remove the final throw. See docs/ADDING-A-LIBRARY.md for the contract.

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class __CLASS__ {

    static final String YACI_URL = "http://localhost:8080/api/v1/";
    static final String MNEMONIC =
        "test test test test test test test test test test test test test test test test test test test test test test test sauce";

    public static void main(String[] args) throws Exception {
        // PLUTUS_JSON lets the cross-check runner point this same flow at any
        // on-chain blueprint (aiken, scalus, …). Falls back to the local Aiken
        // blueprint for standalone runs.
        String override = System.getenv("PLUTUS_JSON");
        Path blueprintPath = (override != null && !override.isBlank())
            ? Paths.get(override)
            : Paths.get(System.getProperty("user.dir"), "..", "..", "onchain", "aiken", "plutus.json");

        String json = Files.readString(blueprintPath);

        // Load the validator BY TITLE (not by array index). Minimal regex pull so
        // the skeleton has no extra deps; replace with PlutusBlueprintLoader once
        // you wire in your SDK.
        String title = "__EXAMPLE__.__EXAMPLE__.spend"; // TODO: match your validator title
        String compiledCode = extractCompiledCode(json, title);
        System.out.println("=== __EXAMPLE__ scenario (scaffold) ===");
        System.out.println("Loaded validator '" + title + "' (" + compiledCode.length() / 2 + " bytes)");

        // TODO: build an Account from MNEMONIC + a BackendService against YACI_URL.
        // TODO: build -> submit -> confirm the use-case transaction(s).
        // TODO: throw on any failure so the cross-check marks this combo red.

        throw new AssertionError("__EXAMPLE__ off-chain flow not implemented yet");
    }

    private static String extractCompiledCode(String json, String title) {
        Matcher m = Pattern.compile(
            "\\{[^{}]*\"title\"\\s*:\\s*\"" + Pattern.quote(title) +
            "\"[^{}]*\"compiledCode\"\\s*:\\s*\"([0-9a-fA-F]+)\"", Pattern.DOTALL).matcher(json);
        if (m.find()) return m.group(1);
        // Fallback: first compiledCode in the document.
        Matcher f = Pattern.compile("\"compiledCode\"\\s*:\\s*\"([0-9a-fA-F]+)\"").matcher(json);
        if (f.find()) return f.group(1);
        throw new IllegalStateException("validator not found: " + title);
    }
}
