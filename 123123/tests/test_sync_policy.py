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

    def test_notice_data_writable_by_admin_and_leader(self):
        # 内部通知：导师与组长可发布并同步，学生只读
        self.assertTrue(sync_policy.can_write(self.admin, "noticeData", self.matrix))
        self.assertTrue(sync_policy.can_write(self.leader, "noticeData", self.matrix))
        self.assertFalse(sync_policy.can_write(self.student, "noticeData", self.matrix))
        self.assertTrue(sync_policy.can_read(self.student, "noticeData"))

    def test_news_data_writable_by_admin_and_leader(self):
        self.assertTrue(sync_policy.can_write(self.admin, "newsData", self.matrix))
        self.assertTrue(sync_policy.can_write(self.leader, "newsData", self.matrix))
        self.assertFalse(sync_policy.can_write(self.student, "newsData", self.matrix))

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

    def test_project_application_ledger_follows_project_permissions(self):
        # 项目申报台账：全员可读（含学生），只有具备「项目管理（编辑）」的角色可写
        self.assertTrue(sync_policy.can_read(self.student, "projectApplicationData"))
        self.assertTrue(sync_policy.can_read(self.leader, "projectApplicationData"))
        self.assertFalse(sync_policy.can_read(self.visitor, "projectApplicationData"))
        self.assertTrue(sync_policy.can_write(self.admin, "projectApplicationData", self.matrix))
        self.assertFalse(sync_policy.can_write(self.student, "projectApplicationData", self.matrix))
        self.assertFalse(sync_policy.can_write(self.leader, "projectApplicationData", self.matrix))
        rows = [{"id": 1, "name": "某申报项目", "year": "2026", "status": "申报中"}]
        self.assertEqual(rows, sync_policy.validate_value("projectApplicationData", rows))
        with self.assertRaises(sync_policy.SyncPolicyError):
            sync_policy.validate_value("projectApplicationData", {"not": "a list"})

    def test_student_reads_only_own_rows(self):
        rows = [
            {"id": 1, "owner": "学生甲", "content": "mine"},
            {"id": 2, "owner": "学生乙", "content": "private"},
        ]
        filtered = sync_policy.filter_read_value(
            "weeklyReportData", rows, self.student
        )
        self.assertEqual([1], [row["id"] for row in filtered])

    def test_student_reads_weekly_by_student_id_even_if_name_differs(self):
        rows = [
            {"id": 1, "owner": "旧名", "studentId": "S01", "content": "mine"},
            {"id": 2, "owner": "别人", "studentId": "S99", "content": "other"},
        ]
        filtered = sync_policy.filter_read_value(
            "weeklyReportData", rows, self.student
        )
        self.assertEqual([1], [row["id"] for row in filtered])

    def test_student_receives_full_team_roster(self):
        rows = [
            {"id": 1, "name": "导师"},
            {"id": 2, "name": "学生甲"},
            {"id": 3, "name": "学生乙"},
        ]
        filtered = sync_policy.filter_read_value(
            "teamMemberData", rows, self.student
        )
        self.assertEqual(3, len(filtered))
        self.assertTrue(sync_policy.can_read(self.student, "approvalFlowConfig"))
        self.assertTrue(sync_policy.can_read(self.student, "holidayLeaveCampaigns"))

    def test_student_sees_team_visible_tasks(self):
        rows = [
            {"id": 1, "owner": "学生甲", "visibility": "private"},
            {"id": 2, "owner": "导师", "visibility": "all"},
            {"id": 3, "owner": "学生乙", "visibility": "private"},
        ]
        filtered = sync_policy.filter_read_value("taskData", rows, self.student)
        self.assertEqual([1, 2], [row["id"] for row in filtered])

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

    def test_achievement_extra_accepts_object_map(self):
        value = sync_policy.validate_value(
            "researchAchievementExtra",
            {"论文:1": {"roleType": "主持", "doi": "10.1/x"}},
        )
        self.assertIsInstance(value, dict)
        with self.assertRaises(sync_policy.SyncPolicyError):
            sync_policy.validate_value("researchAchievementExtra", [])

    def test_project_extra_accepts_object_map(self):
        value = sync_policy.validate_value(
            "researchProjectExtra",
            {"lon:1": {"note": "ok"}},
        )
        self.assertIsInstance(value, dict)

    def test_collaboration_object_keys_are_registered(self):
        for key in (
            "datasetGroups",
            "datasetCustomTags",
            "datasetDownloadLogs",
            "sharedFileDownloadLogs",
            "datasetFavorites",
            "homeQuickNavPrefs_v1",
        ):
            self.assertIn(key, sync_policy.APP_SYNC_KEYS)
            self.assertIn(key, sync_policy.STUDENT_READ_KEYS)
            self.assertNotIn(key, sync_policy.PUBLIC_READ_KEYS)
        for key in sync_policy.OBJECT_MERGE_KEYS:
            self.assertNotIn(key, sync_policy.ARRAY_KEYS)

    def test_object_merge_keys_are_writable_by_every_member_role(self):
        for key in ("datasetDownloadLogs", "sharedFileDownloadLogs", "datasetFavorites", "homeQuickNavPrefs_v1"):
            self.assertTrue(sync_policy.can_write(self.admin, key, self.matrix))
            self.assertTrue(sync_policy.can_write(self.leader, key, self.matrix))
            self.assertTrue(sync_policy.can_write(self.student, key, self.matrix))
            self.assertFalse(sync_policy.can_write(self.visitor, key, self.matrix))

    def test_dataset_groups_and_tags_follow_resource_center_feature(self):
        self.assertTrue(sync_policy.can_write(self.leader, "datasetGroups", self.matrix))
        self.assertTrue(sync_policy.can_write(self.leader, "datasetCustomTags", self.matrix))
        # 学生不具备行级所有权语义，不得改写全队共享的分组/标签。
        self.assertFalse(sync_policy.can_write(self.student, "datasetGroups", self.matrix))
        self.assertFalse(sync_policy.can_write(self.student, "datasetCustomTags", self.matrix))

    def test_object_key_schemas_reject_wrong_shapes(self):
        with self.assertRaises(sync_policy.SyncPolicyError):
            sync_policy.validate_value("datasetDownloadLogs", [])
        with self.assertRaises(sync_policy.SyncPolicyError):
            sync_policy.validate_value("datasetDownloadLogs", {"f1": {"not": "list"}})
        with self.assertRaises(sync_policy.SyncPolicyError):
            sync_policy.validate_value("datasetFavorites", {"S01": ["not-a-map"]})
        with self.assertRaises(sync_policy.SyncPolicyError):
            sync_policy.validate_value("homeQuickNavPrefs_v1", {"S01": {"not": "list"}})
        self.assertEqual(
            {"f1": [{"user": "a"}]},
            sync_policy.validate_value("datasetDownloadLogs", {"f1": [{"user": "a"}]}),
        )
        self.assertEqual(
            {"S01": {"12": True}},
            sync_policy.validate_value("datasetFavorites", {"S01": {"12": True}}),
        )

    def test_student_download_log_write_merges_and_keeps_other_entries(self):
        current = {
            "f1": [{"user": "学生乙", "time": "t1"}],
            "f2": [{"user": "学生丙", "time": "t0"}],
        }
        incoming = {"f1": [{"user": "学生甲", "time": "t2"}]}
        merged = sync_policy.merge_object_write(
            "datasetDownloadLogs", incoming, current, self.student
        )
        self.assertIn({"user": "学生乙", "time": "t1"}, merged["f1"])
        self.assertIn({"user": "学生甲", "time": "t2"}, merged["f1"])
        # 未涉及的文件记录完整保留
        self.assertEqual(current["f2"], merged["f2"])

    def test_leader_can_replace_download_logs_for_cleanup(self):
        current = {"f1": [{"user": "旧记录"}]}
        merged = sync_policy.merge_object_write(
            "sharedFileDownloadLogs", {}, current, self.leader
        )
        self.assertEqual({}, merged)

    def test_per_user_bucket_write_only_touches_own_bucket(self):
        current = {"S01": {"1": True}, "S99": {"2": True}}
        incoming = {"S01": {"3": True}, "S99": {"hacked": True}}
        merged = sync_policy.merge_object_write(
            "datasetFavorites", incoming, current, self.student
        )
        self.assertEqual({"3": True}, merged["S01"])
        # 他人桶保持服务端现状，入侵性修改被丢弃
        self.assertEqual({"2": True}, merged["S99"])

    def test_per_user_bucket_allows_clearing_own_bucket_only(self):
        current = {"S01": {"1": True}, "S99": {"2": True}}
        merged = sync_policy.merge_object_write(
            "homeQuickNavPrefs_v1", {}, {"S01": [1], "S99": [2]}, self.student
        )
        self.assertNotIn("S01", merged)
        self.assertEqual([2], merged["S99"])
        favorites = sync_policy.merge_object_write(
            "datasetFavorites", {}, current, self.student
        )
        self.assertEqual({"2": True}, favorites["S99"])

    def test_per_user_bucket_admin_can_repair_whole_document(self):
        merged = sync_policy.merge_object_write(
            "datasetFavorites", {"S42": {"9": True}}, {"S99": {"2": True}}, self.admin
        )
        self.assertEqual({"S42": {"9": True}}, merged)

    def test_student_download_log_entries_are_capped(self):
        incoming = {"f1": [{"i": n} for n in range(150)]}
        merged = sync_policy.merge_object_write(
            "datasetDownloadLogs", incoming, {}, self.student
        )
        self.assertEqual(100, len(merged["f1"]))
