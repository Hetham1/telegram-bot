ALTER TABLE prompts ADD COLUMN series_id TEXT;

WITH RECURSIVE prompt_roots(id, series_id) AS (
  SELECT id, id FROM prompts WHERE id NOT LIKE 's:%'
  UNION ALL
  SELECT child.id, roots.series_id
  FROM prompt_roots roots
  JOIN prompts parent ON parent.id = roots.id
  JOIN prompts child ON child.id = 's:' || parent.answer_update_id
)
UPDATE prompts SET series_id = COALESCE(
  (SELECT series_id FROM prompt_roots WHERE prompt_roots.id = prompts.id), id
);

CREATE INDEX prompts_series_answers ON prompts(series_id, answer);
