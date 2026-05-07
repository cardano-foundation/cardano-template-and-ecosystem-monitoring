///usr/bin/env jbang "$0" "$@" ; exit $?
//JAVA 24+
//DEPS com.bloxbean.cardano:cardano-client-lib:0.7.0-beta2
//DEPS com.fasterxml.jackson.core:jackson-databind:2.18.1

// CCL-Java conformance adapter — run-primitive entry point.
//
// Reads a scenario JSON, dispatches on scenario.primitive to the matching
// impl under primitive_impls/, compares observed to expected, writes a
// result.json per the runner contract, and exits non-zero on failure.
//
// Usage: jbang RunPrimitive.java <scenario.json>

import com.bloxbean.cardano.client.address.Address;
import com.bloxbean.cardano.client.crypto.Blake2bUtil;
import com.bloxbean.cardano.client.plutus.spec.BigIntPlutusData;
import com.bloxbean.cardano.client.plutus.spec.BytesPlutusData;
import com.bloxbean.cardano.client.plutus.spec.ConstrPlutusData;
import com.bloxbean.cardano.client.plutus.spec.ListPlutusData;
import com.bloxbean.cardano.client.plutus.spec.MapPlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusData;
import com.bloxbean.cardano.client.util.HexUtil;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.math.BigInteger;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;

public class RunPrimitive {
    static final String FRAMEWORK = "ccl-java";
    static final ObjectMapper MAPPER = new ObjectMapper();

    public static void main(String[] args) throws Exception {
        if (args.length < 1) {
            System.err.println("usage: jbang RunPrimitive.java <scenario.json>");
            System.exit(64);
        }
        long start = System.currentTimeMillis();

        Path scenarioPath = Paths.get(args[0]);
        JsonNode scenario = MAPPER.readTree(Files.readString(scenarioPath));
        String id = scenario.get("id").asText();
        String primitive = scenario.get("primitive").asText();
        String era = scenario.get("era").asText();
        JsonNode input = scenario.get("input");
        JsonNode expected = scenario.get("expected");

        ObjectNode out = MAPPER.createObjectNode();
        out.put("tier", "primitive");
        out.put("id", id);
        out.put("primitive", primitive);
        out.put("framework", FRAMEWORK);
        out.put("era", era);

        try {
            JsonNode observed;
            switch (primitive) {
                case "encoding/datum-cbor-roundtrip":
                case "encoding/plutus-data-canonical-order":
                    observed = datumCborRoundtrip(input);
                    break;
                case "encoding/address-bech32-roundtrip":
                    observed = addressBech32Roundtrip(input);
                    break;
                default:
                    out.put("status", "skipped");
                    out.put("error_summary", "primitive '" + primitive + "' not implemented in " + FRAMEWORK);
                    out.put("duration_ms", System.currentTimeMillis() - start);
                    Files.writeString(Paths.get("result.json"), MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(out));
                    System.exit(0);
                    return;
            }

            out.set("observed", observed);
            out.set("expected", expected);
            if (observed.equals(expected)) {
                out.put("status", "pass");
            } else {
                out.put("status", "fail");
                out.put("error_summary", "observed != expected");
            }
        } catch (Exception e) {
            out.put("status", "fail");
            out.put("error_summary", "impl threw: " + e.getMessage());
        }

        out.put("duration_ms", System.currentTimeMillis() - start);
        Files.writeString(Paths.get("result.json"), MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(out));
        if ("pass".equals(out.get("status").asText()) || "skipped".equals(out.get("status").asText())) {
            System.exit(0);
        } else {
            System.exit(1);
        }
    }

    static JsonNode datumCborRoundtrip(JsonNode input) throws Exception {
        JsonNode pd = input.get("plutus_data");
        if (pd == null) throw new Exception("scenario input missing 'plutus_data'");
        PlutusData data = toPlutusData(pd);
        byte[] cborBytes = data.serialize();
        String cborHex = HexUtil.encodeHexString(cborBytes);
        byte[] hash = Blake2bUtil.blake2bHash256(cborBytes);
        ObjectNode out = MAPPER.createObjectNode();
        out.put("cbor_hex", cborHex);
        out.put("blake2b_256", HexUtil.encodeHexString(hash));
        return out;
    }

    static JsonNode addressBech32Roundtrip(JsonNode input) {
        String hex = input.get("address_bytes_hex").asText();
        byte[] bytes = HexUtil.decodeHexString(hex);
        Address addr = new Address(bytes);
        ObjectNode out = MAPPER.createObjectNode();
        out.put("bech32", addr.toBech32());
        return out;
    }

    static PlutusData toPlutusData(JsonNode j) throws Exception {
        if (j.has("int")) {
            return BigIntPlutusData.of(new BigInteger(j.get("int").asText()));
        }
        if (j.has("bytes")) {
            return BytesPlutusData.of(HexUtil.decodeHexString(j.get("bytes").asText()));
        }
        if (j.has("list")) {
            ListPlutusData.ListPlutusDataBuilder lb = ListPlutusData.builder();
            ListPlutusData list = lb.build();
            for (JsonNode item : j.get("list")) list.add(toPlutusData(item));
            return list;
        }
        if (j.has("map")) {
            MapPlutusData m = new MapPlutusData();
            for (JsonNode pair : j.get("map")) {
                m.put(toPlutusData(pair.get("k")), toPlutusData(pair.get("v")));
            }
            return m;
        }
        if (j.has("constructor") && j.has("fields")) {
            ListPlutusData fields = ListPlutusData.builder().build();
            for (JsonNode f : j.get("fields")) fields.add(toPlutusData(f));
            return ConstrPlutusData.builder()
                    .alternative(j.get("constructor").asLong())
                    .data(fields)
                    .build();
        }
        throw new Exception("unrecognized plutus_data shape: " + j.toString());
    }
}
