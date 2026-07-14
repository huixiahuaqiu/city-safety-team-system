-- 内网自建后的 RLS 基线（针对当前「patents 表存 KV」模式）
-- 执行前请确认真实表名/列名与线上一致；默认按 classification = '__APP_SYNC__' 同步标记。
-- 目标：anon 仅能读写同步 KV 行；禁止误伤业务专利数据。按团队策略收紧。

-- 示例：若表名为 patents
ALTER TABLE IF EXISTS public.patents ENABLE ROW LEVEL SECURITY;

-- 清理旧策略（可重复执行）
DROP POLICY IF EXISTS app_sync_select ON public.patents;
DROP POLICY IF EXISTS app_sync_insert ON public.patents;
DROP POLICY IF EXISTS app_sync_update ON public.patents;
DROP POLICY IF EXISTS app_sync_delete ON public.patents;

-- 只允许带同步标记的行对 authenticated/anon 可见（按你实际 auth 模型调整 TO 子句）
CREATE POLICY app_sync_select ON public.patents
  FOR SELECT
  TO anon, authenticated
  USING (classification = '__APP_SYNC__');

CREATE POLICY app_sync_insert ON public.patents
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (classification = '__APP_SYNC__');

CREATE POLICY app_sync_update ON public.patents
  FOR UPDATE
  TO anon, authenticated
  USING (classification = '__APP_SYNC__')
  WITH CHECK (classification = '__APP_SYNC__');

-- 默认禁止前端删除；如需允许可放开
-- CREATE POLICY app_sync_delete ON public.patents
--   FOR DELETE TO authenticated
--   USING (classification = '__APP_SYNC__');

-- service_role 绕过 RLS，仅放服务端 .env，切勿进前端。

COMMENT ON TABLE public.patents IS '含业务专利 + __APP_SYNC__ KV；RLS 限制前端仅触达同步行';
