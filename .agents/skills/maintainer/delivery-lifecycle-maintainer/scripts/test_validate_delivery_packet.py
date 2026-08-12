#!/usr/bin/env python3
"""Deterministic regression checks for delivery packet terminal identity gates."""

from __future__ import annotations

import copy
import json
import unittest
from pathlib import Path

from validate_delivery_packet import validate


TEMPLATE = Path(__file__).parents[1] / "assets" / "delivery-packet.template.json"
SOURCE_SHA = "1" * 40
BASE_SHA = "2" * 40
REMOTE_SHA = "3" * 40
TREE_SHA = "4" * 40
DELIVERED_SHA = "5" * 40


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


class DeliveryPacketValidatorTest(unittest.TestCase):
    def test_template_is_valid_draft(self) -> None:
        packet = json.loads(TEMPLATE.read_text())
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


if __name__ == "__main__":
    unittest.main()
