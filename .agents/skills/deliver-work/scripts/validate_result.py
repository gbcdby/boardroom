#!/usr/bin/env python3
"""Check work-result/v1 records locally; never authorizes or executes an action."""
import argparse
import json
from pathlib import Path
import sys

OUTCOMES = {"COMPLETE", "PASS", "FAIL", "INCONCLUSIVE", "BLOCKED", "NOT_RUN"}
CONTEXT_KEYS = ("base_id", "contract_id", "environment_id", "worktree_digest", "version")
ASSESSMENTS = {"PASS", "FAIL", "INCONCLUSIVE", "NOT_RUN"}
NON_PASS_STATUSES = {"FAIL", "FAILED", "FAILURE", "ERROR", "COUNTEREXAMPLE", "NOT_RUN",
                     "TOOL_ERROR", "INCONCLUSIVE", "BLOCKED", "HISTORICAL", "SKIP",
                     "SKIPPED", "TIMEOUT", "UNKNOWN", "CANCELLED", "CANCELED",
                     "PENDING", "RUNNING", "ABORTED", "NOT_EXECUTED"}

def validate(data):
    errors, warnings = [], []
    if not isinstance(data, dict):
        return ["result must be an object"], []
    if data.get("schema_version") != "work-result/v1":
        errors.append("schema_version must be work-result/v1")
    for key in ("work_id", "skill"):
        if not isinstance(data.get(key), str) or not data[key].strip():
            errors.append(key + " must be a nonempty string")
    if not isinstance(data.get("outcome"), str) or data["outcome"] not in OUTCOMES:
        errors.append("outcome is not supported")
    subject = data.get("subject")
    if not isinstance(subject, dict):
        errors.append("subject must be an object")
        subject = {}
    for key in ("kind", "id"):
        if not isinstance(subject.get(key), str) or not subject[key].strip():
            errors.append("subject." + key + " must be a nonempty string")
    for key in ("unresolved", "changed_assumptions"):
        if not isinstance(data.get(key), list):
            errors.append(key + " must be an array")
    if not isinstance(data.get("next_action"), str) or not data["next_action"].strip():
        errors.append("next_action must be a nonempty string")
    evidence = data.get("evidence")
    if not isinstance(evidence, list):
        errors.append("evidence must be an array")
        evidence = []
    seen, supports_pass = set(), False
    for n, item in enumerate(evidence):
        prefix = "evidence[" + str(n) + "]"
        if not isinstance(item, dict):
            errors.append(prefix + " must be an object")
            continue
        for key in ("id", "locator", "scope", "status", "producer", "subject_id"):
            if not isinstance(item.get(key), str) or not item[key].strip():
                errors.append(prefix + "." + key + " must be a nonempty string")
        evidence_id = item.get("id")
        if isinstance(evidence_id, str):
            if evidence_id in seen:
                errors.append(prefix + " duplicates an evidence id")
            seen.add(evidence_id)
        relation = item.get("relation", "direct")
        if relation not in ("direct", "background"):
            errors.append(prefix + ".relation must be direct or background")
        if relation == "background":
            continue
        same = item.get("subject_id") == subject.get("id")
        if not same:
            errors.append(prefix + " directly supports a different subject; reassess or mark as background")
        for key in CONTEXT_KEYS:
            if key in subject and key not in item:
                warnings.append(prefix + " does not state " + key + "; applicability needs review")
            elif key in subject and item.get(key) != subject.get(key):
                errors.append(prefix + " has a different " + key)
                same = False
        status = item.get("status")
        normalized_status = status.strip().upper().replace("-", "_").replace(" ", "_") if isinstance(status, str) else ""
        assessment = item.get("assessment")
        if assessment is not None and (not isinstance(assessment, str) or assessment not in ASSESSMENTS):
            errors.append(prefix + ".assessment is not supported")
        if assessment == "PASS" and normalized_status in NON_PASS_STATUSES:
            errors.append(prefix + " cannot convert failed, unknown, unrun or historical evidence into PASS")
            same = False
        if normalized_status == "PASS_WITHIN_SCOPE" and subject.get("kind") != "model":
            errors.append(prefix + " model-only PASS_WITHIN_SCOPE cannot directly certify a non-model subject")
            same = False
        passed = assessment == "PASS" if assessment is not None else status in ("PASS", "PASS_WITHIN_SCOPE")
        if same and isinstance(status, str) and passed:
            supports_pass = True
            if status == "OBSERVED":
                warnings.append(prefix + " supports only its declared static/applicability assessment, not runtime behavior")
    if data.get("outcome") == "PASS" and not supports_pass:
        errors.append("PASS needs matching direct evidence with PASS/PASS_WITHIN_SCOPE or an explicit assessment=PASS; preserve the raw status")
    if data.get("outcome") == "PASS" and data.get("unresolved"):
        warnings.append("PASS has unresolved items: confirm none are required checks or acceptance blockers")
    warnings.append("This checks record consistency only, not evidence truth, coverage, permissions, runtime locks, or delivery facts.")
    return errors, warnings

def reject_constant(value):
    raise ValueError("non-finite JSON number: " + value)

def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key: " + key)
        result[key] = value
    return result

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("result", type=Path)
    args = parser.parse_args()
    try:
        if args.result.stat().st_size > 5_000_000:
            raise ValueError("record exceeds 5 MB")
        data = json.loads(args.result.read_text(encoding="utf-8"),
                          parse_constant=reject_constant, object_pairs_hook=unique_object)
        errors, warnings = validate(data)
    except (OSError, ValueError) as exc:
        errors, warnings = [str(exc)], []
    print(json.dumps({"valid": not errors, "errors": errors, "warnings": warnings},
                     ensure_ascii=False, indent=2))
    return 0 if not errors else 1

if __name__ == "__main__":
    sys.exit(main())
