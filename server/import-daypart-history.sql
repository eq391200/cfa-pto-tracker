-- Historical Daypart Sales Data: March 2025 – February 2026
-- Run: sqlite3 /var/www/admin-hub/data/pto.db < /var/www/admin-hub/data/import-daypart-history.sql

-- March 2025
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2025-03', 'sales_breakfast', 26779.00) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2025-03', 'sales_lunch', 146233.38) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2025-03', 'sales_afternoon', 128329.23) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2025-03', 'sales_dinner', 197813.14) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;

-- April 2025
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2025-04', 'sales_breakfast', 22096.81) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2025-04', 'sales_lunch', 147323.54) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2025-04', 'sales_afternoon', 126068.67) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2025-04', 'sales_dinner', 183388.42) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;

-- May 2025
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2025-05', 'sales_breakfast', 22257.53) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2025-05', 'sales_lunch', 161393.17) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2025-05', 'sales_afternoon', 121257.86) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2025-05', 'sales_dinner', 184546.26) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;

-- June 2025
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2025-06', 'sales_breakfast', 19216.46) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2025-06', 'sales_lunch', 133571.69) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2025-06', 'sales_afternoon', 108485.86) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2025-06', 'sales_dinner', 161479.95) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;

-- July 2025
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2025-07', 'sales_breakfast', 19052.66) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2025-07', 'sales_lunch', 135711.18) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2025-07', 'sales_afternoon', 105694.50) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2025-07', 'sales_dinner', 160949.79) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;

-- August 2025
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2025-08', 'sales_breakfast', 19351.13) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2025-08', 'sales_lunch', 134474.47) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2025-08', 'sales_afternoon', 114787.98) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2025-08', 'sales_dinner', 172074.70) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;

-- September 2025
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2025-09', 'sales_breakfast', 26420.25) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2025-09', 'sales_lunch', 130569.80) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2025-09', 'sales_afternoon', 115771.18) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2025-09', 'sales_dinner', 170616.98) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;

-- October 2025
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2025-10', 'sales_breakfast', 24046.04) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2025-10', 'sales_lunch', 142727.68) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2025-10', 'sales_afternoon', 118509.98) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2025-10', 'sales_dinner', 176092.75) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;

-- November 2025
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2025-11', 'sales_breakfast', 22133.64) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2025-11', 'sales_lunch', 127042.87) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2025-11', 'sales_afternoon', 106345.51) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2025-11', 'sales_dinner', 168900.42) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;

-- December 2025
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2025-12', 'sales_breakfast', 25427.11) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2025-12', 'sales_lunch', 148765.05) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2025-12', 'sales_afternoon', 116229.51) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2025-12', 'sales_dinner', 182967.61) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;

-- January 2026
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2026-01', 'sales_breakfast', 23095.72) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2026-01', 'sales_lunch', 135357.27) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2026-01', 'sales_afternoon', 125271.65) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2026-01', 'sales_dinner', 179060.18) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;

-- February 2026
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2026-02', 'sales_breakfast', 26293.27) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2026-02', 'sales_lunch', 127156.80) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2026-02', 'sales_afternoon', 118449.21) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;
INSERT INTO scorecard_entries (month, metric_key, metric_value) VALUES ('2026-02', 'sales_dinner', 177326.70) ON CONFLICT(month, metric_key) DO UPDATE SET metric_value = excluded.metric_value;
