import unittest

import sync_policy


class SyncPolicyTests(unittest.TestCase):
    def setUp(self):
        self.admin = {"sub": "1", "sid": "admin", "name": "导师", "role": "admin"}
        self.leader = {"sub": "2", "sid": "L01", "name": "组长甲", "role": "leader"}
        self.student = {"sub": "3", "sid": "S01", "name": "学生甲", "role": "student"}
        self.visitor = {"sub": "4", "sid": "V01", "name": "访客", "role": "visitor"}
        self.matrix = [list(row) for row in sync_policy.DEFAULT_PERMISSION_ROWS]

    def test_read_allowlists_hide_sensitive_whole_documents(self):
        self.assertTrue(sync_policy.can_read(self.admin, "operationLogData"))
        self.assertFalse(sync_policy.can_read(self.leader, "operationLogData"))
        self.assertFalse(sync_policy.can_read(self.student, "backupData"))
        self.assertTrue(sync_policy.can_read(self.student, "applicationData"))
        self.assertFalse(sync_policy.can_read(self.visitor, "teamMemberData"))
        self.assertTrue(sync_policy.can_read(self.visitor, "literatureData"))

    def test_permission_matrix_is_enforced_on_server_writes(self):
        self.assertTrue(
            sync_policy.can_write(self.leader, "sharedFileData", self.matrix)
        )
        self.assertFalse(
            sync_policy.can_write(self.leader, "patentData", self.matrix)
        )
        achievement = next(
            row for row in self.matrix if row[0] == "成果管理（编辑）"
        )
        achievement[2] = True
        self.assertTrue(
            sync_policy.can_write(self.leader, "patentData", self.matrix)
        )
        achievement[2] = False
        self.assertFalse(
            sync_policy.can_write(self.leader, "patentData", self.matrix)
        )

    def test_browser_cannot_overwrite_server_owned_audit_documents(self):
        for claims in (self.admin, self.leader, self.student, self.visitor):
            self.assertFalse(
                sync_policy.can_write(claims, "operationLogData", self.matrix)
            )
            self.assertFalse(
                sync_policy.can_write(claims, "loginLogData", self.matrix)
            )

    def test_student_reads_only_own_rows(self):
        rows = [
            {"id": 1, "owner": "学生甲", "content": "mine"},
            {"id": 2, "owner": "学生乙", "content": "private"},
        ]
        filtered = sync_policy.filter_read_value(
            "weeklyReportData", rows, self.student
        )
        self.assertEqual([1], [row["id"] for row in filtered])

    def test_student_scoped_write_preserves_other_users(self):
        current = [
            {"id": 1, "owner": "学生甲", "content": "old"},
            {"id": 2, "owner": "学生乙", "content": "keep"},
        ]
        incoming = [{"id": 1, "owner": "学生甲", "content": "new"}]
        merged = sync_policy.merge_scoped_write(
            "weeklyReportData", incoming, current, self.student
        )
        self.assertEqual(
            {1: "new", 2: "keep"},
            {row["id"]: row["content"] for row in merged},
        )

    def test_student_cannot_claim_or_reuse_another_users_row(self):
        current = [{"id": 2, "owner": "学生乙", "content": "private"}]
        incoming = [{"id": 2, "owner": "学生甲", "content": "takeover"}]
        with self.assertRaises(sync_policy.SyncPolicyError):
            sync_policy.merge_scoped_write(
                "weeklyReportData", incoming, current, self.student
            )

    def test_literature_schema_rejects_xss_strings_in_numeric_fields(self):
        with self.assertRaises(sync_policy.SyncPolicyError):
            sync_policy.validate_value(
                "literatureData",
                [
                    {
                        "id": 1,
                        "title": "safe",
                        "citations": "<img onerror=alert(1)>",
                        "downloadCount": 0,
                    }
                ],
            )

    def test_key_registry_matches_new_frontend_collaboration_keys(self):
        for key in (
            "portalFeedbackData_v1",
            "literatureCompareDimTemplate",
            "literatureCompareNamedDimTemplates",
            "customInstructionTemplates",
            "devlogEntries",
            "researchAchievementExtra",
        ):
            self.assertIn(key, sync_policy.APP_SYNC_KEYS)


if __name__ == "__main__":
    unittest.main()
