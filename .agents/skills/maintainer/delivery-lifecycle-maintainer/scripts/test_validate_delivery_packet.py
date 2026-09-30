#!/usr/bin/env python3
"""Deterministic regression checks for delivery packet terminal identity gates."""

from __future__ import annotations

import copy
import json
import unittest
from pathlib import Path
from unittest.mock import patch

from validate_delivery_packet import ACCEPTANCE_PACKET_FINGERPRINT_METHOD, validate


TEMPLATE = Path(__file__).parents[1] / "assets" / "delivery-packet.template.json"
SOURCE_SHA = "1" * 40
BASE_SHA = "2" * 40
REMOTE_SHA = "3" * 40
TREE_SHA = "4" * 40
DELIVERED_SHA = "5" * 40
DEFAULT_FINGERPRINT = "bbb9274ef6b2df46c7d2a17dbc49a31054b352c2261af97ab8345adc84741263"
METHOD_FINGERPRINT = "5cdfce86038025d8dfe27c86ce64c879440cb4232628b7b2d2e76cb8f5ee87a6"
NUMERIC_FINGERPRINT = "005779f5b99eacd6df256f6888b90ef2abfa20d69b837551a3947b9fe26e47b7"


def delivered_packet() -> dict:
    packet = json.loads(TEMPLATE.read_text())
    packet["status"] = "delivered"
    packet["candidate"]["source_sha"] = SOURCE_SHA
    packet["candidate"]["build"]["source_sha"] = SOURCE_SHA
    packet["candidate"]["runtime"]["source_sha"] = SOURCE_SHA
    for receipt, verdict in (("reviewer", "accept"), ("verifier", "PASS"), ("final_review", "accept")):
        packet["receipts"][receipt]["verdict"] = verdict
        packet["receipts"][receipt]["source_sha"] = SOURCE_SHA
    integration = packet["integration"]
    integration["authorized"] = True
    integration["base_sha"] = BASE_SHA
    integration["observed_remote_sha"] = REMOTE_SHA
    integration["patch_tree_sha"] = TREE_SHA
    integration["expected_old_sha"] = BASE_SHA
    integration["index_update_mode"] = "none"
    integration["cas"] = {
        "attempted": True,
        "succeeded": True,
        "observed_old_sha": BASE_SHA,
        "delivered_sha": DELIVERED_SHA,
    }
    preservation = packet["preservation"]
    preservation["checked"] = True
    preservation["unrelated_paths_preserved"] = True
    preservation["index_preserved"] = True
    packet["terminal"] = {
        "delivered_ref": "refs/heads/main",
        "delivered_sha": DELIVERED_SHA,
        "delivered_tree_sha": TREE_SHA,
        "timestamp": "2026-08-12T00:00:00Z",
        "proof": ["exact-candidate receipts and preservation evidence"],
    }
    return packet


def fingerprinted_packet(*, include_method: bool = False, reverse_keys: bool = False) -> dict:
    packet = delivered_packet()
    inventory_items = [
        ("state", "默认"),
        ("controls", ["创建", "取消"]),
        ("note", "雪\n灯"),
    ]
    criteria = ["创建 Project", "second\nline"]
    fields = [
        ("version", "1"),
        ("criteria", criteria),
        ("state_inventory", [dict(reversed(inventory_items) if reverse_keys else inventory_items)]),
    ]
    if include_method:
        fields.append(("fingerprint_method", ACCEPTANCE_PACKET_FINGERPRINT_METHOD))
    acceptance_packet = dict(reversed(fields) if reverse_keys else fields)
    acceptance_packet["fingerprint"] = METHOD_FINGERPRINT if include_method else DEFAULT_FINGERPRINT
    packet["candidate"]["acceptance_packet"] = acceptance_packet
    return packet


class DeliveryPacketValidatorTest(unittest.TestCase):
    def test_template_is_valid_draft(self) -> None:
        packet = json.loads(TEMPLATE.read_text())
        self.assertEqual(validate(packet), [])

    def test_legacy_packet_without_acceptance_fingerprint_is_valid(self) -> None:
        packet = delivered_packet()
        del packet["candidate"]["acceptance_packet"]["fingerprint"]
        self.assertEqual(validate(packet), [])

    def test_real_sha_delivered_packet_is_valid(self) -> None:
        self.assertEqual(validate(delivered_packet()), [])

    def test_delivered_packet_rejects_sha_placeholder(self) -> None:
        packet = delivered_packet()
        packet["candidate"]["source_sha"] = "replace-with-40-char-sha"
        packet["candidate"]["build"]["source_sha"] = "replace-with-40-char-sha"
        packet["candidate"]["runtime"]["source_sha"] = "replace-with-40-char-sha"
        for receipt in packet["receipts"].values():
            receipt["source_sha"] = "replace-with-40-char-sha"
        errors = validate(packet)
        self.assertTrue(any("candidate.source_sha must be" in error for error in errors))

    def test_delivered_packet_rejects_terminal_placeholder(self) -> None:
        packet = delivered_packet()
        packet["integration"]["cas"]["delivered_sha"] = "replace-with-delivered-sha"
        packet["terminal"]["delivered_sha"] = "replace-with-delivered-sha"
        errors = validate(packet)
        self.assertTrue(any("integration.cas.delivered_sha must be" in error for error in errors))
        self.assertTrue(any("terminal.delivered_sha must be" in error for error in errors))

    def test_invalid_index_update_mode_is_rejected(self) -> None:
        packet = copy.deepcopy(delivered_packet())
        packet["integration"]["index_update_mode"] = "live_index"
        self.assertIn(
            "integration.index_update_mode must be none or alternate_index",
            validate(packet),
        )

    def test_declared_fingerprint_uses_jq_default_with_unicode_sorted_keys_and_newline(self) -> None:
        self.assertEqual(validate(fingerprinted_packet()), [])
        self.assertEqual(validate(fingerprinted_packet(reverse_keys=True)), [])

    def test_supported_optional_fingerprint_method_is_verified(self) -> None:
        self.assertEqual(validate(fingerprinted_packet(include_method=True)), [])

    def test_jq_numeric_canonicalization_is_used(self) -> None:
        packet = fingerprinted_packet()
        acceptance_packet = packet["candidate"]["acceptance_packet"]
        acceptance_packet["numeric_fixture"] = {"whole_float": 1.0, "small_exponent": 1e-7}
        acceptance_packet["fingerprint"] = NUMERIC_FINGERPRINT
        self.assertEqual(validate(packet), [])

    def test_missing_jq_fails_closed_for_real_fingerprints(self) -> None:
        with patch(
            "validate_delivery_packet.subprocess.run",
            side_effect=FileNotFoundError("jq"),
        ):
            self.assertIn(
                "jq is required to verify candidate.acceptance_packet.fingerprint",
                validate(fingerprinted_packet()),
            )

    def test_unsupported_or_malformed_fingerprint_method_is_rejected(self) -> None:
        for method in ("sha256", "", None, 7):
            with self.subTest(method=method):
                packet = fingerprinted_packet(include_method=True)
                packet["candidate"]["acceptance_packet"]["fingerprint_method"] = method
                self.assertIn(
                    "candidate.acceptance_packet.fingerprint_method is unsupported or malformed",
                    validate(packet),
                )

    def test_fingerprint_method_requires_a_fingerprint(self) -> None:
        packet = fingerprinted_packet(include_method=True)
        del packet["candidate"]["acceptance_packet"]["fingerprint"]
        self.assertIn(
            "candidate.acceptance_packet.fingerprint_method requires fingerprint",
            validate(packet),
        )

    def test_malformed_and_mismatched_acceptance_fingerprints_are_rejected(self) -> None:
        packet = fingerprinted_packet()
        packet["candidate"]["acceptance_packet"]["fingerprint"] = "A" * 64
        self.assertIn(
            "candidate.acceptance_packet.fingerprint must be a 64-character lowercase SHA-256",
            validate(packet),
        )

        packet = fingerprinted_packet()
        packet["candidate"]["acceptance_packet"]["fingerprint"] = "0" * 64
        self.assertIn(
            "candidate.acceptance_packet.fingerprint does not match its canonical contents",
            validate(packet),
        )

    def test_changed_acceptance_criteria_invalidate_fingerprint(self) -> None:
        packet = fingerprinted_packet()
        packet["candidate"]["acceptance_packet"]["criteria"][0] = "Changed Project criterion"
        self.assertIn(
            "candidate.acceptance_packet.fingerprint does not match its canonical contents",
            validate(packet),
        )


if __name__ == "__main__":
    unittest.main()
