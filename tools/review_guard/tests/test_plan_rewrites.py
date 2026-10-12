"""Issue #46 contract tests, derived from the Issue and approved scope only.

Proposed API (not an assertion that an existing export has this shape):

    tools.review_guard.plan_rewrites.check_rewrite_batch(
        *, base_plans, candidate_plans, changed_paths, base_sha,
        base_allowlist, candidate_allowlist, split_map_bytes,
        base_inputs, candidate_inputs, check_plan, check_publication=None,
    ) -> {"ok": bool, "errors": [{"path": str, ...}],
          "exempted_paths": [str]}

Plans are path -> JSON object mappings. The allowlist and split-map shapes are
proposed in plan_rewrite_fixtures.py. Missing base_allowlist means no exception.
split_map_bytes is UTF-8 JSON; its exact bytes are SHA-256 checked against the
base allowlist. candidate_allowlist grants no authority. Only an existing plan
listed in base can be exempted from the changed-plan count and old-base checks.
Zero or one unlisted changed plan remains subject to the original rules.

check_plan(path, plan, *, catalog, ledger, global_ids, config) -> bool receives
only base_inputs. Every changed candidate plan must pass it.
Only host callers pass check_publication(path, plan) -> bool. If supplied, every
changed candidate plan must pass it and failures propagate. CI callers omit it;
omission does not claim publication checking happened. That runs before push.
Errors' prose, ordering, and code vocabulary are intentionally unspecified.
JSON Pointers grant changes to string leaves only. A pointer naming an object
grants its free text, while decision fields and conflict state stay protected.

These spies test invocation, input forwarding and failure propagation only.
The separate test_plan_rewrites_ci.py requires real guard/CI and host CLI wiring.
No CLI extension is guessed here. Run only in a credential-free sandbox.
"""

from copy import deepcopy
import hashlib
import importlib
from pathlib import Path
import sys
import unittest

from plan_rewrite_fixtures import (
    BASE_SHA, PLAN_A, PLAN_B, OPS_LEDGER, OPS_REVIEWER,
    SHARED_TEXT, encode_map, fallback, make_batch, project_ledger, split_map, variant,
)


class PlanRewriteContractTests(unittest.TestCase):
    def call(self, batch, *, failed_plan=None, failed_publication=None, host=False):
        """Missing API is an assertion within each case; other imports propagate."""
        root = Path(__file__).resolve().parents[3]
        module_path = root / "tools/review_guard/plan_rewrites.py"
        self.assertTrue(module_path.is_file(), "Issue #46 proposed plan_rewrites API is not implemented")
        if str(root) not in sys.path:
            sys.path.insert(0, str(root))
        module = importlib.import_module("tools.review_guard.plan_rewrites")
        api = getattr(module, "check_rewrite_batch", None)
        self.assertTrue(callable(api), "Issue #46 proposed check_rewrite_batch export is not implemented")
        self.plan_calls = []
        self.publication_calls = []

        def check_plan(path, value, *, catalog, ledger, global_ids, config):
            self.plan_calls.append((path, deepcopy(value), deepcopy({
                "catalog": catalog, "ledger": ledger, "global_ids": global_ids, "config": config,
            })))
            return path != failed_plan

        def check_publication(path, value):
            self.publication_calls.append((path, deepcopy(value)))
            return path != failed_publication

        callbacks = {"check_plan": check_plan}
        if host:
            callbacks["check_publication"] = check_publication
        self.result = api(**batch, **callbacks)
        self.assertIsInstance(self.result, dict)
        self.assertIs(type(self.result.get("ok")), bool)
        self.assertIsInstance(self.result.get("errors"), list)
        self.assertIsInstance(self.result.get("exempted_paths"), list)
        return self.result

    def accept(self, batch, expected_exemptions=None, *, host=False):
        result = self.call(batch, host=host)
        self.assertTrue(result["ok"], result["errors"])
        self.assertEqual(result["errors"], [])
        self.assertCountEqual(result["exempted_paths"], expected_exemptions if expected_exemptions is not None else batch["changed_paths"])
        return result

    def reject(self, batch, path=None, **kwargs):
        result = self.call(batch, **kwargs)
        self.assertFalse(result["ok"], "An unauthorized or unchecked change must fail")
        self.assertTrue(result["errors"])
        if path is not None:
            self.assertIn(path, [error.get("path") for error in result["errors"]])
        return result

    def test_listed_multiple_plans_with_old_base_can_pass(self):
        batch = make_batch()
        self.assertNotEqual(batch["candidate_plans"][PLAN_A]["base_sha"], BASE_SHA)
        self.accept(batch)

    def test_only_common_context_items_may_be_deleted(self):
        batch = make_batch((PLAN_A,))
        batch["candidate_plans"][PLAN_A]["variant_analysis"] = deepcopy(batch["base_plans"][PLAN_A]["variant_analysis"])
        self.accept(batch)

    def test_variant_mapping_and_original_invariant_fallback_can_pass(self):
        batch = make_batch((PLAN_A,))
        self.assertEqual(batch["candidate_plans"][PLAN_A]["variant_analysis"][1], fallback(variant()))
        self.accept(batch)

    def test_named_ledger_resolution_can_change(self):
        batch = make_batch((OPS_LEDGER,))
        batch["candidate_plans"][OPS_LEDGER]["conflicts"][5]["resolution"] = "Synthetic replacement resolution."
        self.accept(batch)

    def test_named_reviewer_conflicts_can_change_their_free_text(self):
        batch = make_batch((OPS_REVIEWER,))
        for index in (5, 8):
            batch["candidate_plans"][OPS_REVIEWER]["conflicts"][index]["description"] = "Synthetic replacement description."
            batch["candidate_plans"][OPS_REVIEWER]["conflicts"][index]["resolution"] = "Synthetic replacement resolution."
        self.accept(batch)

    def test_assessment_disposition_cannot_change(self):
        batch = make_batch((PLAN_A,))
        batch["candidate_plans"][PLAN_A]["assessments"][0]["disposition"] = "not-applicable"
        self.reject(batch, PLAN_A)

    def test_assessment_reason_cannot_change(self):
        batch = make_batch((PLAN_A,))
        batch["candidate_plans"][PLAN_A]["assessments"][0]["reason"] = "Changed synthetic reason."
        self.reject(batch, PLAN_A)

    def test_assessment_identity_and_decision_references_cannot_change(self):
        for key, value in (("id", "INV-OTHER"), ("decision_references", ["synthetic-decision.md"])):
            with self.subTest(field=key):
                batch = make_batch((PLAN_A,))
                batch["candidate_plans"][PLAN_A]["assessments"][0][key] = value
                self.reject(batch, PLAN_A)

    def test_assessments_cannot_be_added_or_deleted(self):
        for action in ("add", "delete"):
            with self.subTest(action=action):
                batch = make_batch((PLAN_A,))
                assessments = batch["candidate_plans"][PLAN_A]["assessments"]
                if action == "add":
                    assessments.append(deepcopy(assessments[0]))
                else:
                    assessments.pop()
                self.reject(batch, PLAN_A)

    def test_check_id_method_expected_and_coverage_cannot_change(self):
        for key, value in (("id", "OTHER"), ("method", "Other method."), ("expected", "Other outcome.")):
            with self.subTest(field=key):
                batch = make_batch((PLAN_A,))
                batch["candidate_plans"][PLAN_A]["assessments"][0]["checks"][0][key] = value
                self.reject(batch, PLAN_A)
        batch = make_batch((PLAN_A,))
        batch["candidate_plans"][PLAN_A]["assessments"][0]["checks"] = []
        self.reject(batch, PLAN_A)

    def test_moved_cause_keeps_its_decision_and_notes(self):
        for key, value in (("disposition", "not-applicable"), ("reason", "Other reason."), ("notes", "Other note.")):
            with self.subTest(field=key):
                batch = make_batch((PLAN_A,))
                batch["candidate_plans"][PLAN_A]["variant_analysis"][0][key] = value
                self.reject(batch, PLAN_A)

    def test_moved_cause_pattern_places_and_existing_checks_cannot_change(self):
        original_checks = [{"id": "SYNTHETIC-V1", "method": "Inspect synthetic location.", "expected": "Location remains covered."}]
        changes = [
            ("pattern", "changed-pattern"),
            ("places", [{"location": "src/other-synthetic.py", "result": "Other synthetic result."}]),
            ("checks", []),
        ]
        for check_key in ("id", "method", "expected"):
            changed_checks = deepcopy(original_checks)
            changed_checks[0][check_key] = "changed synthetic check"
            changes.append(("checks", changed_checks))
        for key, value in changes:
            with self.subTest(field=key, value=value):
                batch = make_batch((PLAN_A,))
                before = batch["base_plans"][PLAN_A]["variant_analysis"][0]
                after = batch["candidate_plans"][PLAN_A]["variant_analysis"][0]
                before["checks"] = deepcopy(original_checks)
                after["checks"] = deepcopy(original_checks)
                after[key] = value
                self.reject(batch, PLAN_A)

    def test_non_named_free_text_cannot_change(self):
        batch = make_batch((OPS_LEDGER,))
        batch["candidate_plans"][OPS_LEDGER]["conflicts"][4]["resolution"] = "Other resolution."
        self.reject(batch, OPS_LEDGER)

    def test_reviewer_non_named_conflict_text_cannot_change(self):
        for index in (4, 6, 7):
            for field in ("description", "resolution"):
                with self.subTest(index=index, field=field):
                    batch = make_batch((OPS_REVIEWER,))
                    batch["candidate_plans"][OPS_REVIEWER]["conflicts"][index][field] = "Changed synthetic conflict text."
                    self.reject(batch, OPS_REVIEWER)

    def test_naming_resolution_does_not_grant_its_sibling_description(self):
        batch = make_batch((OPS_LEDGER,))
        batch["candidate_plans"][OPS_LEDGER]["conflicts"][5]["description"] = "Other description."
        self.reject(batch, OPS_LEDGER)

    def test_object_pointer_cannot_change_conflict_state(self):
        batch = make_batch((OPS_REVIEWER,))
        batch["candidate_plans"][OPS_REVIEWER]["conflicts"][5]["state"] = "open"
        self.reject(batch, OPS_REVIEWER)

    def test_object_pointer_cannot_grant_decision_fields(self):
        for field in ("disposition", "reason", "checks"):
            with self.subTest(field=field):
                batch = make_batch((OPS_REVIEWER,))
                before = batch["base_plans"][OPS_REVIEWER]["conflicts"][5]
                before[field] = ["synthetic check"] if field == "checks" else "synthetic decision"
                after = batch["candidate_plans"][OPS_REVIEWER]["conflicts"][5]
                after[field] = ["changed check"] if field == "checks" else "changed decision"
                self.reject(batch, OPS_REVIEWER)

    def test_even_base_text_pointer_cannot_grant_a_decision_change(self):
        batch = make_batch((PLAN_A,))
        batch["base_allowlist"]["plans"][0]["editable_text"] = ["/assessments/0/reason"]
        batch["candidate_plans"][PLAN_A]["assessments"][0]["reason"] = "Other decision reason."
        self.reject(batch, PLAN_A)

    def test_named_object_pointer_cannot_add_or_remove_structure(self):
        for action in ("add", "delete"):
            with self.subTest(action=action):
                batch = make_batch((OPS_REVIEWER,))
                conflict = batch["candidate_plans"][OPS_REVIEWER]["conflicts"][5]
                if action == "add":
                    conflict["new_field"] = "Added free text."
                else:
                    del conflict["resolution"]
                self.reject(batch, OPS_REVIEWER)

    def test_other_plan_fields_cannot_change(self):
        for key, value in (("schema_version", 1), ("task_id", "OTHER"), ("base_sha", BASE_SHA), ("planned_paths", []), ("boundaries", []), ("notes", "Other note.")):
            with self.subTest(field=key):
                batch = make_batch((PLAN_A,))
                batch["candidate_plans"][PLAN_A][key] = value
                self.reject(batch, PLAN_A)

    def test_unknown_plan_field_cannot_be_added(self):
        batch = make_batch((PLAN_A,))
        batch["candidate_plans"][PLAN_A]["new_field"] = "Synthetic new field."
        self.reject(batch, PLAN_A)

    def test_local_context_cannot_be_deleted_or_rewritten(self):
        for action in ("delete", "rewrite"):
            with self.subTest(action=action):
                batch = make_batch((PLAN_A,))
                context = batch["candidate_plans"][PLAN_A]["context"]
                if action == "delete":
                    del context["INV-OLD"]
                else:
                    context["INV-OLD"]["condition"] = "Changed local condition."
                self.reject(batch, PLAN_A)

    def test_local_history_uses_base_project_rows_and_preserves_source_order(self):
        batch = make_batch((PLAN_A,))
        history = batch["candidate_plans"][PLAN_A]["context"]["INV-OLD"]["history"]
        self.assertEqual(history, project_ledger()["findings"])
        self.assertEqual([row["id"] for row in history], ["C-0003", "C-0005"])
        self.accept(batch)

    def test_local_history_follows_source_order_even_when_ledger_order_differs(self):
        batch = make_batch((PLAN_A,))
        batch["base_plans"][PLAN_A]["context"]["INV-OLD"]["history"].reverse()
        batch["candidate_plans"][PLAN_A]["context"]["INV-OLD"]["history"].reverse()
        self.assertEqual([row["id"] for row in batch["candidate_plans"][PLAN_A]["context"]["INV-OLD"]["history"]], ["C-0005", "C-0003"])
        self.accept(batch)

    def test_local_history_omits_project_ledger_row_absent_from_source_history(self):
        batch = make_batch((PLAN_A,))
        batch["base_plans"][PLAN_A]["context"]["INV-OLD"]["history"].pop()
        batch["candidate_plans"][PLAN_A]["context"]["INV-OLD"]["history"].pop()
        self.assertEqual(len(batch["base_inputs"]["ledger"]["findings"]), 2)
        self.accept(batch)

    def test_local_history_cannot_add_real_ledger_row_absent_from_source_history(self):
        batch = make_batch((PLAN_A,))
        batch["base_plans"][PLAN_A]["context"]["INV-OLD"]["history"].pop()
        # C-0005 is real and mapped, but its PR1-R004 source is absent.
        self.reject(batch, PLAN_A)

    def test_local_history_wrong_id_text_sources_or_missing_fields_is_rejected(self):
        for key, value in (("id", "C-9999"), ("lesson", "Invented project lesson."),
                           ("sources", ["https://example.invalid/other"]),
                           ("invariant_id", "INV-GLOBAL"), ("cause_key", "other-key"), ("notes", "Invented history note.")):
            with self.subTest(field=key):
                batch = make_batch((PLAN_A,))
                batch["candidate_plans"][PLAN_A]["context"]["INV-OLD"]["history"][0][key] = value
                self.reject(batch, PLAN_A)
        for key in ("id", "lesson", "sources", "invariant_id", "cause_key"):
            with self.subTest(missing=key):
                batch = make_batch((PLAN_A,))
                del batch["candidate_plans"][PLAN_A]["context"]["INV-OLD"]["history"][0][key]
                self.reject(batch, PLAN_A)

    def test_local_history_cannot_reorder_add_or_delete_project_rows(self):
        for action in ("reorder", "add", "delete"):
            with self.subTest(action=action):
                batch = make_batch((PLAN_A,))
                history = batch["candidate_plans"][PLAN_A]["context"]["INV-OLD"]["history"]
                if action == "reorder":
                    history.reverse()
                elif action == "add":
                    history.append(deepcopy(history[0]))
                else:
                    history.pop()
                self.reject(batch, PLAN_A)

    def test_both_history_must_use_project_id_and_lesson(self):
        for key, value in (("id", "C-0004"), ("invariant_id", "INV-GLOBAL"),
                           ("cause_key", "shared-both-a"), ("lesson", SHARED_TEXT)):
            with self.subTest(field=key):
                batch = make_batch((PLAN_A,))
                batch["candidate_plans"][PLAN_A]["context"]["INV-OLD"]["history"][1][key] = value
                self.reject(batch, PLAN_A)

    def test_global_only_history_cannot_be_kept_in_project_context(self):
        batch = make_batch((PLAN_A,))
        history = batch["candidate_plans"][PLAN_A]["context"]["INV-OLD"]["history"]
        history.insert(1, deepcopy(batch["base_plans"][PLAN_A]["context"]["INV-OLD"]["history"][1]))
        self.reject(batch, PLAN_A)

    def test_candidate_ledger_cannot_authorize_history_text(self):
        batch = make_batch((PLAN_A,))
        invented = project_ledger()
        invented["findings"][0]["lesson"] = "Candidate-authorized lesson."
        batch["candidate_inputs"]["ledger"] = invented
        batch["candidate_plans"][PLAN_A]["context"]["INV-OLD"]["history"][0]["lesson"] = invented["findings"][0]["lesson"]
        self.reject(batch, PLAN_A)

    def test_missing_base_project_row_cannot_authorize_history(self):
        batch = make_batch((PLAN_A,))
        batch["base_inputs"]["ledger"]["findings"].pop()
        self.reject(batch, PLAN_A)

    def test_common_context_cannot_be_rewritten_or_added(self):
        for action in ("rewrite", "add"):
            with self.subTest(action=action):
                batch = make_batch((PLAN_A,))
                item = deepcopy(batch["base_plans"][PLAN_A]["context"]["INV-GLOBAL"])
                item["condition"] = "Changed common condition."
                batch["candidate_plans"][PLAN_A]["context"]["INV-GLOBAL"] = item
                if action == "add":
                    batch["candidate_plans"][PLAN_A]["context"]["INV-ADDED-COMMON"] = deepcopy(item)
                self.reject(batch, PLAN_A)

    def test_variant_keys_must_match_the_same_map_target(self):
        for invariant_id, cause_key in (("INV-OLD", "new-a"), ("INV-GLOBAL", "old-a"), ("INV-GLOBAL", "new-b"), ("INV-UNKNOWN", "new-a")):
            with self.subTest(invariant_id=invariant_id, cause_key=cause_key):
                batch = make_batch((PLAN_A,))
                row = batch["candidate_plans"][PLAN_A]["variant_analysis"][0]
                row["invariant_id"], row["cause_key"] = invariant_id, cause_key
                self.reject(batch, PLAN_A)

    def test_unmapped_variant_cannot_change(self):
        batch = make_batch((PLAN_A,))
        batch["base_plans"][PLAN_A]["variant_analysis"].append(variant("unmapped"))
        batch["candidate_plans"][PLAN_A]["variant_analysis"].append(variant("invented", "INV-GLOBAL"))
        self.reject(batch, PLAN_A)

    def test_moved_cause_row_cannot_be_deleted_or_duplicated(self):
        for action in ("delete", "duplicate"):
            with self.subTest(action=action):
                batch = make_batch((PLAN_A,))
                rows = batch["candidate_plans"][PLAN_A]["variant_analysis"]
                if action == "delete":
                    rows.pop(0)
                else:
                    rows.append(deepcopy(rows[0]))
                self.reject(batch, PLAN_A)

    def test_both_keeps_the_original_project_keys(self):
        batch = make_batch((PLAN_A,))
        before = batch["base_plans"][PLAN_A]
        before["variant_analysis"] = [variant("both-a")]
        batch["candidate_plans"][PLAN_A]["variant_analysis"] = deepcopy(before["variant_analysis"])
        self.accept(batch)

    def test_both_cannot_switch_to_the_shared_target(self):
        batch = make_batch((PLAN_A,))
        batch["base_plans"][PLAN_A]["variant_analysis"] = [variant("both-a")]
        batch["candidate_plans"][PLAN_A]["variant_analysis"] = [variant("shared-both-a", "INV-GLOBAL"), fallback(variant("both-a"))]
        self.reject(batch, PLAN_A)

    def test_fallback_is_not_added_when_original_invariant_remains_covered(self):
        batch = make_batch((PLAN_A,))
        local = variant("local-a")
        batch["base_plans"][PLAN_A]["variant_analysis"].append(deepcopy(local))
        batch["candidate_plans"][PLAN_A]["variant_analysis"] = [batch["candidate_plans"][PLAN_A]["variant_analysis"][0], local]
        self.accept(batch)

    def test_unnecessary_fallback_cannot_be_added(self):
        batch = make_batch((PLAN_A,))
        batch["base_plans"][PLAN_A]["variant_analysis"].append(variant("local-a"))
        batch["candidate_plans"][PLAN_A]["variant_analysis"].append(variant("local-a"))
        self.reject(batch, PLAN_A)

    def test_two_moved_causes_with_same_pattern_places_need_one_fallback(self):
        batch = make_batch((PLAN_A,))
        batch["base_plans"][PLAN_A]["variant_analysis"].append(variant("old-b"))
        batch["candidate_plans"][PLAN_A]["variant_analysis"].insert(1, variant("new-b", "INV-GLOBAL"))
        self.accept(batch)

    def test_fallback_must_keep_pattern_and_places_and_no_cause_decision(self):
        for key, value in (("pattern", "other-pattern"), ("places", []), ("cause_key", "old-a"), ("disposition", "preserve"), ("reason", "Invented reason."), ("notes", "Invented note.")):
            with self.subTest(field=key):
                batch = make_batch((PLAN_A,))
                batch["candidate_plans"][PLAN_A]["variant_analysis"][1][key] = value
                self.reject(batch, PLAN_A)

    def test_duplicate_fallback_cannot_be_added(self):
        batch = make_batch((PLAN_A,))
        batch["candidate_plans"][PLAN_A]["variant_analysis"].append(fallback(variant()))
        self.reject(batch, PLAN_A)

    def test_fallback_cannot_be_added_for_an_unselected_original_invariant(self):
        batch = make_batch((PLAN_A,))
        for plans in (batch["base_plans"], batch["candidate_plans"]):
            plans[PLAN_A]["assessments"] = [row for row in plans[PLAN_A]["assessments"] if row["id"] != "INV-OLD"]
        self.reject(batch, PLAN_A)

    def test_missing_required_fallback_cannot_pass(self):
        batch = make_batch((PLAN_A,))
        batch["candidate_plans"][PLAN_A]["variant_analysis"].pop()
        self.reject(batch, PLAN_A)

    def test_single_unlisted_current_base_plan_keeps_old_rules(self):
        batch = make_batch((PLAN_A,))
        batch["base_allowlist"]["plans"] = []
        batch["candidate_plans"][PLAN_A]["base_sha"] = BASE_SHA
        batch["candidate_plans"][PLAN_A]["assessments"][0]["reason"] = "Ordinary plan update."
        self.accept(batch, [])

    def test_unlisted_old_base_plan_is_rejected(self):
        batch = make_batch((PLAN_A,))
        batch["base_allowlist"]["plans"] = []
        self.reject(batch, PLAN_A)

    def test_two_unlisted_current_base_plans_are_rejected(self):
        batch = make_batch()
        batch["base_allowlist"]["plans"] = []
        for path in (PLAN_A, PLAN_B):
            batch["candidate_plans"][path]["base_sha"] = BASE_SHA
        result = self.reject(batch)
        self.assertEqual(result["exempted_paths"], [])

    def test_listed_rewrite_and_one_normal_current_base_plan_can_pass(self):
        batch = make_batch()
        batch["base_allowlist"]["plans"] = [entry for entry in batch["base_allowlist"]["plans"] if entry["path"] != PLAN_B]
        batch["candidate_plans"][PLAN_B]["base_sha"] = BASE_SHA
        self.accept(batch, [PLAN_A])

    def test_listed_rewrite_does_not_exempt_an_unlisted_old_base_plan(self):
        batch = make_batch()
        batch["base_allowlist"]["plans"] = [entry for entry in batch["base_allowlist"]["plans"] if entry["path"] != PLAN_B]
        result = self.reject(batch, PLAN_B)
        self.assertNotIn(PLAN_B, result["exempted_paths"])

    def test_head_allowlist_cannot_self_authorize_multiple_old_base_plans(self):
        batch = make_batch()
        batch["base_allowlist"] = None
        result = self.reject(batch)
        self.assertEqual(result["exempted_paths"], [])

    def test_head_pointer_cannot_self_authorize_other_free_text(self):
        batch = make_batch((PLAN_A,))
        batch["candidate_allowlist"]["plans"][0]["editable_text"].append("/notes")
        batch["candidate_plans"][PLAN_A]["notes"] = "Head-authorized note."
        self.reject(batch, PLAN_A)

    def test_head_allowlist_removal_does_not_remove_base_authority(self):
        batch = make_batch()
        batch["candidate_allowlist"] = None
        self.accept(batch)

    def test_digest_mismatch_is_rejected_even_if_head_digest_matches(self):
        batch = make_batch((PLAN_A,))
        batch["split_map_bytes"] += b"\n"
        batch["candidate_allowlist"]["split_map_sha256"] = hashlib.sha256(batch["split_map_bytes"]).hexdigest()
        result = self.reject(batch)
        self.assertEqual(result["exempted_paths"], [])

    def test_matching_base_digest_is_not_overridden_by_bad_head_digest(self):
        batch = make_batch((PLAN_A,))
        batch["candidate_allowlist"]["split_map_sha256"] = "0" * 64
        self.accept(batch)

    def test_map_target_cannot_be_changed_under_an_old_base_digest(self):
        batch = make_batch((PLAN_A,))
        changed_map = split_map()
        changed_map["findings"][0]["to"]["cause_key"] = "forged-key"
        batch["split_map_bytes"] = encode_map(changed_map)
        batch["candidate_plans"][PLAN_A]["variant_analysis"][0]["cause_key"] = "forged-key"
        self.reject(batch)

    def test_new_plan_cannot_gain_a_rewrite_exception_from_a_listed_path(self):
        batch = make_batch((PLAN_A,))
        del batch["base_plans"][PLAN_A]
        result = self.reject(batch, PLAN_A)
        self.assertNotIn(PLAN_A, result["exempted_paths"])

    def test_deleted_plan_cannot_gain_a_rewrite_exception(self):
        batch = make_batch((PLAN_A,))
        del batch["candidate_plans"][PLAN_A]
        result = self.reject(batch, PLAN_A)
        self.assertNotIn(PLAN_A, result["exempted_paths"])

    def test_unchanged_listed_plan_is_not_reported_as_exempted(self):
        batch = make_batch((PLAN_A,))
        self.accept(batch, [PLAN_A])
        self.assertNotIn(PLAN_B, self.result["exempted_paths"])

    def test_every_rewrite_runs_plan_check_with_base_materials(self):
        batch = make_batch()
        self.accept(batch)
        self.assertCountEqual([path for path, _, _ in self.plan_calls], [PLAN_A, PLAN_B])
        for path, value, materials in self.plan_calls:
            self.assertEqual(value, batch["candidate_plans"][path])
            self.assertEqual(materials, batch["base_inputs"])
            self.assertNotEqual(materials, batch["candidate_inputs"])

    def test_other_review_artifacts_do_not_gain_plan_exemptions(self):
        batch = make_batch((PLAN_A,))
        batch["changed_paths"].extend([".review/mekiki/global-ids.json", ".review/config.toml", "src/synthetic.py"])
        self.accept(batch, [PLAN_A])
        self.assertEqual([path for path, _, _ in self.plan_calls], [PLAN_A])
        self.assertEqual(self.plan_calls[0][2], batch["base_inputs"])

    def test_new_shape_plan_check_failure_is_not_exempted(self):
        batch = make_batch()
        self.reject(batch, PLAN_B, failed_plan=PLAN_B)
        self.assertIn(PLAN_B, [path for path, _, _ in self.plan_calls])

    def test_common_context_left_in_plan_still_reaches_plan_check(self):
        batch = make_batch((PLAN_A,))
        batch["candidate_plans"][PLAN_A]["context"] = deepcopy(batch["base_plans"][PLAN_A]["context"])
        self.reject(batch, PLAN_A, failed_plan=PLAN_A)
        self.assertIn(PLAN_A, [path for path, _, _ in self.plan_calls])

    def test_every_rewrite_runs_the_host_publication_callback(self):
        batch = make_batch()
        self.accept(batch, host=True)
        self.assertCountEqual([path for path, _ in self.publication_calls], [PLAN_A, PLAN_B])
        for path, value in self.publication_calls:
            self.assertEqual(value, batch["candidate_plans"][path])

    def test_named_free_text_still_requires_publication_check(self):
        batch = make_batch((OPS_LEDGER,))
        batch["candidate_plans"][OPS_LEDGER]["conflicts"][5]["resolution"] = SHARED_TEXT
        self.reject(batch, OPS_LEDGER, failed_publication=OPS_LEDGER, host=True)
        self.assertIn(OPS_LEDGER, [path for path, _ in self.publication_calls])

    def test_single_unlisted_plan_still_runs_plan_and_publication_checks(self):
        batch = make_batch((PLAN_A,))
        batch["base_allowlist"] = None
        batch["candidate_plans"][PLAN_A]["base_sha"] = BASE_SHA
        self.accept(batch, [], host=True)
        self.assertEqual([path for path, _, _ in self.plan_calls], [PLAN_A])
        self.assertEqual([path for path, _ in self.publication_calls], [PLAN_A])

    def test_ci_caller_omits_the_host_publication_callback(self):
        batch = make_batch()
        self.accept(batch)
        self.assertEqual(self.publication_calls, [])
        self.assertCountEqual([path for path, _, _ in self.plan_calls], [PLAN_A, PLAN_B])

    def test_policy_does_not_rewrite_or_mutate_input_plans(self):
        batch = make_batch((PLAN_A,))
        snapshot = deepcopy(batch)
        self.accept(batch)
        self.assertEqual(batch, snapshot)
