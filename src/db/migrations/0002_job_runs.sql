-- When each scheduled job last ran, on the campus clock.
--
-- The digests, the reminders and the living this week message are jobs on an
-- hourly clock, and section 7 of the design asks that a bot which was down over
-- a digest hour sends the digest when it returns rather than skipping the week
-- or sending it twice. A job with no memory skips, and a job that remembers
-- only inside one process sends twice after a restart, so the memory is a row
-- in this table. One row per job, keyed by the job's name and replaced on every
-- run, which is what the scheduler in src/jobs/scheduler.ts reads to work out
-- which campus hours it still owes.
CREATE TABLE `Job_Runs` (
	`job_name` varchar(64) NOT NULL,
	`last_run_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `Job_Runs_job_name` PRIMARY KEY(`job_name`)
);
