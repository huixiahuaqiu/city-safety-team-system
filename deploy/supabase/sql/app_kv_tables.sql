-- OPTIONAL migration scaffold — 不自动执行。
-- 目标：从 patents 表 KV 模式迁移到专用业务表（applications / notices / weekly_reports 等）。
-- 与 rls_app_sync.sql 并存；执行前请备份并在 staging 验证。

-- ---------- 通用 KV 同步元数据 ----------
CREATE TABLE IF NOT EXISTS public.app_sync_meta (
  id            bigserial PRIMARY KEY,
  sync_key      text NOT NULL UNIQUE,
  description   text,
  schema_version int NOT NULL DEFAULT 1,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text DEFAULT 'system'
);

COMMENT ON TABLE public.app_sync_meta IS '前端/网关同步键注册表；便于审计与版本管理';

-- ---------- 岗位申请（applications） ----------
CREATE TABLE IF NOT EXISTS public.applications (
  id              bigserial PRIMARY KEY,
  external_id     text UNIQUE,
  applicant_name  text NOT NULL,
  applicant_email text,
  position        text,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'reviewing', 'accepted', 'rejected', 'withdrawn')),
  payload         jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_applications_status ON public.applications (status);
CREATE INDEX IF NOT EXISTS idx_applications_updated ON public.applications (updated_at DESC);

-- ---------- 通知公告（notices） ----------
CREATE TABLE IF NOT EXISTS public.notices (
  id           bigserial PRIMARY KEY,
  title        text NOT NULL,
  body         text,
  category     text DEFAULT 'general',
  pinned       boolean NOT NULL DEFAULT false,
  published_at timestamptz,
  expires_at   timestamptz,
  author       text,
  payload      jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notices_published ON public.notices (published_at DESC NULLS LAST);

-- ---------- 周报（weekly_reports） ----------
CREATE TABLE IF NOT EXISTS public.weekly_reports (
  id            bigserial PRIMARY KEY,
  owner_id      text,
  owner_name    text,
  week_start    date NOT NULL,
  week_end      date NOT NULL,
  title         text,
  content       text,
  status        text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'submitted', 'approved')),
  attachments   jsonb NOT NULL DEFAULT '[]',
  payload       jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, week_start)
);

CREATE INDEX IF NOT EXISTS idx_weekly_reports_owner_week ON public.weekly_reports (owner_id, week_start DESC);

-- ---------- RLS 占位（按团队 auth 模型收紧） ----------
ALTER TABLE public.applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.weekly_reports ENABLE ROW LEVEL SECURITY;

-- 示例：authenticated 只读已发布公告
DROP POLICY IF EXISTS notices_select_published ON public.notices;
CREATE POLICY notices_select_published ON public.notices
  FOR SELECT TO authenticated
  USING (published_at IS NOT NULL AND published_at <= now()
         AND (expires_at IS NULL OR expires_at > now()));

-- 示例：用户读写自己的周报
DROP POLICY IF EXISTS weekly_reports_owner ON public.weekly_reports;
CREATE POLICY weekly_reports_owner ON public.weekly_reports
  FOR ALL TO authenticated
  USING (owner_id = auth.uid()::text)
  WITH CHECK (owner_id = auth.uid()::text);

-- service_role 用于网关/server 批量同步；勿暴露到前端。
