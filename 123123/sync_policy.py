"""Authorization, validation, and row-scoping rules for collaborative KV sync.

The browser stores several legacy modules as whole JSON documents.  This module
keeps those documents behind explicit role/feature policies and applies row
ownership rules where students are only meant to see or edit their own items.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any, Iterable


APP_SYNC_KEYS = frozenset(
    {
        "teamMemberData",
        "memberGradeYears",
        "permissionMatrix",
        "passwordPolicy",
        "loginLogData",
        "longitudinalData",
        "horizontalData",
        "schoolData",
        "researchProjectExtra",
        "taskData",
        "weeklyReportData",
        "applicationData",
        "approvalFlowConfig",
        "holidayLeaveCampaigns",
        "noticeData",
        "newsData",
        "meetingData",
        "literatureData",
        "datasetData",
        "reportData",
        "sharedFileData",
        "standardData",
        "copyrightData",
        "competitionData",
        "modelTrainingData",
        "annotationTypes",
        "annotationData",
        "knowledgeData",
        "compareLiteratureData",
        "patentData",
        "patentMgmtData",
        "paperData",
        "categoryData",
        "memberData",
        "researchAchievementExtra",
        "systemConfigData",
        "operationLogData",
        "portalContentConfig_v1",
        "portalHomeCarousel_v1",
        "portalContactConfig_v1",
        "portalTeamIntro_v1",
        "portalFeedbackData_v1",
        "literatureCompareDimTemplate",
        "literatureCompareNamedDimTemplates",
        "customInstructionTemplates",
        "devlogEntries",
        "backupData",
        "autoBackupConfig",
    }
)

SERVER_OWNED_AUDIT_KEYS = frozenset({"loginLogData", "operationLogData"})
ADMIN_PRIVATE_KEYS = frozenset(
    {
        "systemConfigData",
        "backupData",
        "autoBackupConfig",
        "loginLogData",
        "operationLogData",
        "devlogEntries",
    }
)

PUBLIC_READ_KEYS = frozenset(
    {
        "permissionMatrix",
        "passwordPolicy",
        "noticeData",
        "newsData",
        "meetingData",
        "literatureData",
        "reportData",
        "standardData",
        "copyrightData",
        "competitionData",
        "patentData",
        "patentMgmtData",
        "paperData",
        "categoryData",
        "portalContentConfig_v1",
        "portalHomeCarousel_v1",
        "portalContactConfig_v1",
        "portalTeamIntro_v1",
    }
)

STUDENT_READ_KEYS = PUBLIC_READ_KEYS | frozenset(
    {
        "permissionMatrix",
        "teamMemberData",
        "memberGradeYears",
        "longitudinalData",
        "horizontalData",
        "schoolData",
        "researchProjectExtra",
        "taskData",
        "weeklyReportData",
        "applicationData",
        "noticeData",
        "datasetData",
        "sharedFileData",
        "modelTrainingData",
        "annotationTypes",
        "annotationData",
        "knowledgeData",
        "compareLiteratureData",
        "memberData",
        "researchAchievementExtra",
        "literatureCompareDimTemplate",
        "literatureCompareNamedDimTemplates",
        "customInstructionTemplates",
    }
)

DEFAULT_PERMISSION_ROWS = (
    ("首页概览", True, True, True, True),
    ("团队成员档案（查看全组）", True, True, False, False),
    ("团队成员档案（仅自己）", True, True, True, False),
    ("团队成员档案（编辑）", True, False, False, False),
    ("角色权限管理", True, False, False, False),
    ("内部任务待办（查看全部）", True, True, False, False),
    ("内部任务待办（查看自己的）", True, True, True, False),
    ("内部任务待办（创建/分配）", True, True, False, False),
    ("团队工作周报（查看全部）", True, True, False, False),
    ("团队工作周报（提交自己的）", True, True, True, False),
    ("团队工作周报（审核）", True, True, False, False),
    ("请假与申请（提交自己的）", True, True, True, False),
    ("请假与申请（本组审批）", True, True, False, False),
    ("请假与申请（审批/查看全部）", True, False, False, False),
    ("请假与申请（流程配置）", True, False, False, False),
    ("项目管理（查看）", True, True, True, False),
    ("项目管理（编辑）", True, False, False, False),
    ("成果管理（查看）", True, True, True, False),
    ("成果管理（编辑）", True, False, False, False),
    ("智能工具（全部）", True, True, True, False),
    ("资源中心（查看）", True, True, True, True),
    ("资源中心（上传/编辑）", True, True, False, False),
    ("账号管理（新建/删除）", True, False, False, False),
    ("账号管理（查看列表）", True, True, False, False),
    ("系统设置", True, False, False, False),
    ("操作日志", True, False, False, False),
    ("数据备份", True, False, False, False),
)

ROLE_COLUMN = {"admin": 1, "leader": 2, "student": 3, "visitor": 4}

KEY_WRITE_FEATURES = {
    "teamMemberData": ("团队成员档案（编辑）",),
    "memberGradeYears": ("团队成员档案（编辑）",),
    "taskData": ("内部任务待办（创建/分配）", "内部任务待办（查看自己的）"),
    "weeklyReportData": ("团队工作周报（提交自己的）", "团队工作周报（审核）"),
    "applicationData": (
        "请假与申请（提交自己的）",
        "请假与申请（本组审批）",
        "请假与申请（审批/查看全部）",
    ),
    "approvalFlowConfig": ("请假与申请（流程配置）",),
    "holidayLeaveCampaigns": ("请假与申请（流程配置）",),
    "longitudinalData": ("项目管理（编辑）",),
    "horizontalData": ("项目管理（编辑）",),
    "schoolData": ("项目管理（编辑）",),
    "researchProjectExtra": ("项目管理（编辑）",),
    "patentData": ("成果管理（编辑）",),
    "patentMgmtData": ("成果管理（编辑）",),
    "paperData": ("成果管理（编辑）",),
    "standardData": ("成果管理（编辑）",),
    "copyrightData": ("成果管理（编辑）",),
    "competitionData": ("成果管理（编辑）",),
    "researchAchievementExtra": ("成果管理（编辑）",),
    "literatureData": ("资源中心（上传/编辑）",),
    "datasetData": ("资源中心（上传/编辑）",),
    "reportData": ("资源中心（上传/编辑）",),
    "sharedFileData": ("资源中心（上传/编辑）",),
    "modelTrainingData": ("智能工具（全部）",),
    "annotationTypes": ("智能工具（全部）",),
    "annotationData": ("智能工具（全部）",),
    "knowledgeData": ("智能工具（全部）",),
    "compareLiteratureData": ("智能工具（全部）",),
    "literatureCompareDimTemplate": ("智能工具（全部）",),
    "literatureCompareNamedDimTemplates": ("智能工具（全部）",),
    "customInstructionTemplates": ("智能工具（全部）",),
    "permissionMatrix": ("角色权限管理",),
    "passwordPolicy": ("系统设置",),
    "systemConfigData": ("系统设置",),
    "noticeData": ("系统设置",),
    "newsData": ("系统设置",),
    "meetingData": ("系统设置",),
    "portalContentConfig_v1": ("系统设置",),
    "portalHomeCarousel_v1": ("系统设置",),
    "portalContactConfig_v1": ("系统设置",),
    "portalTeamIntro_v1": ("系统设置",),
    "portalFeedbackData_v1": ("系统设置",),
    "devlogEntries": ("系统设置",),
    "backupData": ("数据备份",),
    "autoBackupConfig": ("数据备份",),
    "categoryData": ("成果管理（编辑）",),
    "memberData": ("成果管理（编辑）",),
}

STUDENT_SCOPED_WRITE_KEYS = frozenset(
    {"taskData", "weeklyReportData", "applicationData", "annotationData"}
)

ARRAY_KEYS = APP_SYNC_KEYS - frozenset(
    {
        "passwordPolicy",
        "approvalFlowConfig",
        "portalContentConfig_v1",
        "portalHomeCarousel_v1",
        "portalContactConfig_v1",
        "portalTeamIntro_v1",
        "literatureCompareDimTemplate",
        "literatureCompareNamedDimTemplates",
        "customInstructionTemplates",
        "autoBackupConfig",
        "systemConfigData",
    }
)


class SyncPolicyError(ValueError):
    """Raised when a synchronized document violates a security invariant."""


def _role(claims: dict[str, Any] | None) -> str:
    return str((claims or {}).get("role") or "visitor").lower()


def can_read(claims: dict[str, Any] | None, key: str) -> bool:
    role = _role(claims)
    if key not in APP_SYNC_KEYS:
        return False
    if role == "admin":
        return True
    if role == "leader":
        return key not in ADMIN_PRIVATE_KEYS
    if role == "student":
        return key in STUDENT_READ_KEYS
    if role == "visitor":
        return key in PUBLIC_READ_KEYS
    return False


def normalize_permission_matrix(value: Any) -> list[list[Any]]:
    rows = value if isinstance(value, list) else DEFAULT_PERMISSION_ROWS
    normalized: list[list[Any]] = []
    known = {row[0] for row in DEFAULT_PERMISSION_ROWS}
    seen: set[str] = set()
    for row in rows:
        if (
            not isinstance(row, (list, tuple))
            or len(row) != 5
            or not isinstance(row[0], str)
            or row[0] not in known
            or row[0] in seen
            or any(not isinstance(flag, bool) for flag in row[1:])
        ):
            continue
        normalized.append([row[0], *row[1:]])
        seen.add(row[0])
    defaults = {row[0]: row for row in DEFAULT_PERMISSION_ROWS}
    for name in known - seen:
        row = defaults[name]
        normalized.append([row[0], *row[1:]])
    return normalized


def has_feature(permission_matrix: Any, role: str, feature: str) -> bool:
    column = ROLE_COLUMN.get(str(role or "").lower())
    if column is None:
        return False
    for row in normalize_permission_matrix(permission_matrix):
        if row[0] == feature:
            return bool(row[column])
    return False


def can_write(
    claims: dict[str, Any] | None,
    key: str,
    permission_matrix: Any = None,
) -> bool:
    role = _role(claims)
    if key not in APP_SYNC_KEYS or role == "visitor" or key in SERVER_OWNED_AUDIT_KEYS:
        return False
    if role == "admin":
        return True
    features = KEY_WRITE_FEATURES.get(key)
    if not features:
        return False
    if role == "student" and key not in STUDENT_SCOPED_WRITE_KEYS:
        # A student may only mutate documents for which row ownership can be
        # enforced, even if a broad UI feature was accidentally granted.
        return False
    return any(has_feature(permission_matrix, role, feature) for feature in features)


def _validate_shape(value: Any, *, depth: int = 0) -> None:
    if depth > 12:
        raise SyncPolicyError("sync value is nested too deeply")
    if value is None or isinstance(value, (bool, int, float)):
        return
    if isinstance(value, str):
        if len(value) > 100_000:
            raise SyncPolicyError("sync string field is too large")
        return
    if isinstance(value, list):
        if len(value) > 20_000:
            raise SyncPolicyError("sync array has too many items")
        for item in value:
            _validate_shape(item, depth=depth + 1)
        return
    if isinstance(value, dict):
        if len(value) > 200:
            raise SyncPolicyError("sync object has too many fields")
        for key, item in value.items():
            if not isinstance(key, str) or len(key) > 120:
                raise SyncPolicyError("sync object contains an invalid field name")
            _validate_shape(item, depth=depth + 1)
        return
    raise SyncPolicyError("sync value contains an unsupported JSON type")


def _strict_nonnegative_int(value: Any, field: str) -> int:
    if isinstance(value, bool):
        raise SyncPolicyError(f"{field} must be a non-negative integer")
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise SyncPolicyError(f"{field} must be a non-negative integer") from None
    if number < 0 or str(value).strip() not in {str(number), f"{number}.0"}:
        raise SyncPolicyError(f"{field} must be a non-negative integer")
    return number


def validate_value(key: str, value: Any) -> Any:
    if key not in APP_SYNC_KEYS:
        raise SyncPolicyError("unsupported sync key")
    if key in ARRAY_KEYS and not isinstance(value, list):
        raise SyncPolicyError(f"{key} must be a JSON array")
    if key == "permissionMatrix":
        expected_names = {row[0] for row in DEFAULT_PERMISSION_ROWS}
        supplied_names = {
            row[0]
            for row in value
            if isinstance(row, (list, tuple)) and len(row) == 5 and isinstance(row[0], str)
        } if isinstance(value, list) else set()
        normalized = normalize_permission_matrix(value)
        if (
            not isinstance(value, list)
            or len(value) != len(DEFAULT_PERMISSION_ROWS)
            or supplied_names != expected_names
            or len(normalized) != len(DEFAULT_PERMISSION_ROWS)
        ):
            raise SyncPolicyError("permissionMatrix is invalid or incomplete")
        value = normalized
    elif key == "passwordPolicy":
        if not isinstance(value, dict):
            raise SyncPolicyError("passwordPolicy must be an object")
        allowed = {"requireUpper", "requireLower", "requireDigit", "requireSpecial", "minLength"}
        if any(field not in allowed for field in value):
            raise SyncPolicyError("passwordPolicy contains an unsupported field")
        for field in allowed - {"minLength"}:
            if field in value and not isinstance(value[field], bool):
                raise SyncPolicyError(f"{field} must be boolean")
        if "minLength" in value:
            length = _strict_nonnegative_int(value["minLength"], "minLength")
            if length < 8 or length > 128:
                raise SyncPolicyError("minLength must be between 8 and 128")
    elif key == "literatureData":
        for record in value:
            if not isinstance(record, dict):
                raise SyncPolicyError("literatureData items must be objects")
            if "id" in record:
                record["id"] = _strict_nonnegative_int(record["id"], "literatureData.id")
                if record["id"] <= 0:
                    raise SyncPolicyError("literatureData.id must be positive")
            for field in ("citations", "downloadCount"):
                if field in record:
                    record[field] = _strict_nonnegative_int(
                        record[field], f"literatureData.{field}"
                    )
    _validate_shape(value)
    return value


def _identity_values(claims: dict[str, Any] | None) -> set[str]:
    claims = claims or {}
    return {
        str(value).strip().casefold()
        for value in (
            claims.get("sub"),
            claims.get("sid"),
            claims.get("name"),
        )
        if str(value or "").strip()
    }


def _values(record: dict[str, Any], fields: Iterable[str]) -> set[str]:
    result: set[str] = set()
    for field in fields:
        value = record.get(field)
        if isinstance(value, list):
            result.update(str(item).strip().casefold() for item in value if str(item).strip())
        elif str(value or "").strip():
            result.add(str(value).strip().casefold())
    return result


OWNERSHIP_FIELDS = {
    "teamMemberData": ("id", "studentId", "studentNo", "username", "name", "realName"),
    "taskData": (
        "owner",
        "ownerId",
        "assignee",
        "assigneeId",
        "assignedTo",
        "studentId",
        "participants",
    ),
    "weeklyReportData": ("owner", "ownerId", "studentId", "submitter"),
    "applicationData": ("applicant", "applicantId", "studentId", "createdBy"),
    "annotationData": ("owner", "ownerId", "studentId", "assignee"),
}


def is_owned_record(key: str, record: Any, claims: dict[str, Any] | None) -> bool:
    if not isinstance(record, dict):
        return False
    identities = _identity_values(claims)
    if not identities:
        return False
    return bool(identities & _values(record, OWNERSHIP_FIELDS.get(key, ())))


def filter_read_value(key: str, value: Any, claims: dict[str, Any] | None) -> Any:
    if _role(claims) != "student" or key not in OWNERSHIP_FIELDS:
        return deepcopy(value)
    if not isinstance(value, list):
        return []
    return [deepcopy(row) for row in value if is_owned_record(key, row, claims)]


def _record_id(record: Any) -> str:
    if not isinstance(record, dict):
        return ""
    value = record.get("id")
    return str(value).strip() if value is not None else ""


def merge_scoped_write(
    key: str,
    incoming: Any,
    current: Any,
    claims: dict[str, Any] | None,
) -> Any:
    """Merge a student's own rows while preserving every other user's rows."""

    if _role(claims) != "student" or key not in STUDENT_SCOPED_WRITE_KEYS:
        return incoming
    if not isinstance(incoming, list) or not isinstance(current, list):
        raise SyncPolicyError("scoped sync documents must be arrays")

    current_by_id = {_record_id(row): row for row in current if _record_id(row)}
    own_incoming: list[Any] = []
    for row in incoming:
        if not is_owned_record(key, row, claims):
            raise SyncPolicyError("student sync contains a row owned by another user")
        row_id = _record_id(row)
        existing = current_by_id.get(row_id) if row_id else None
        if existing is not None and not is_owned_record(key, existing, claims):
            raise SyncPolicyError("student sync attempts to reuse another user's row id")
        if key == "taskData" and existing is None:
            raise SyncPolicyError("students cannot create or assign tasks")
        own_incoming.append(deepcopy(row))

    preserved = [
        deepcopy(row)
        for row in current
        if not is_owned_record(key, row, claims)
    ]
    return preserved + own_incoming
