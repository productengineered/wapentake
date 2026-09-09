CREATE TABLE actor_grants (
  actor_id TEXT PRIMARY KEY REFERENCES actor_sessions(id) ON DELETE CASCADE,
  execution_scope TEXT NOT NULL CHECK(execution_scope = 'own_jobs')
);

CREATE TABLE job_models (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  owner_actor_id TEXT,
  settings TEXT NOT NULL CHECK(json_valid(settings)),
  settings_hash TEXT NOT NULL
);

CREATE TRIGGER job_models_immutable_update BEFORE UPDATE ON job_models
BEGIN SELECT RAISE(ABORT, 'job model selections are immutable'); END;
CREATE TRIGGER job_models_immutable_delete BEFORE DELETE ON job_models
BEGIN SELECT RAISE(ABORT, 'job model selections are immutable'); END;
