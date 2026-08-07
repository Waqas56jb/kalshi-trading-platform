-- A recycled process is not a failed sync.
--
-- On serverless every invocation is a fresh process, so a run in flight when a
-- container is reclaimed leaves a 'running' row that the reaper then files as an
-- error. Two runs in five were being reported as failures that way, which buried
-- the genuine ones and made the desk look broken while it was syncing 164
-- markets a cycle perfectly well.
--
-- 'abandoned' separates the two. Real errors stay visible; the health endpoint
-- and lastSync ignore abandoned rows, because the work they had already
-- committed is committed.
alter table public.kalshi_sync_runs drop constraint if exists kalshi_sync_runs_status_check;

alter table public.kalshi_sync_runs
  add constraint kalshi_sync_runs_status_check
  check (status in ('running','ok','error','abandoned'));
