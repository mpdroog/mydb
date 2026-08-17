contrib/uitest
==============
Drives the real frontend in a headless DOM against a running mydb, so the
click paths get exercised rather than reasoned about. It found two bugs that
reading the code did not: double-click never firing because the sidebar
rebuilt itself on the first click, and every named-key shortcut silently
missing because `ev.key` is "Enter", not "enter".

Optional, and deliberately outside the build: mydb itself ships with no npm
and no build step, so this pulls its one dependency into a throwaway
directory instead of the repo.

```bash
mkdir -p /tmp/mydb-uitest && cd /tmp/mydb-uitest
npm init -y && npm install jsdom
cp /path/to/mydb/contrib/uitest/ui.mjs .

# needs mydb running with a server named "local" holding a database
# named "mydb_test" (see the seed SQL at the bottom of this file)
node ui.mjs
```

It asserts, against live data: the tree expands lazily, a single click
selects *without replacing the row* (which is what double-click depends on),
double-click opens a tab, the grid renders headers and rows with `NULL` and
binary cells marked, `ORDER BY` puts the newest row first, a 5000-row table
keeps only a viewport of rows in the DOM, tabs switch and close, and named-key
shortcuts fire.

Seed data
---------
```sql
CREATE DATABASE mydb_test CHARACTER SET utf8mb4;
USE mydb_test;
CREATE TABLE orders (
  id INT NOT NULL AUTO_INCREMENT,
  client VARCHAR(300) NULL,
  total DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  status ENUM('new','paid','shipped') NOT NULL DEFAULT 'new',
  notes TEXT NULL,
  payload VARBINARY(64) NULL,
  flags BIT(8) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id), KEY idx_customer (client)
);
INSERT INTO orders (client,total,status,notes,payload,flags) VALUES
 ('acme',12.00,'paid','fine',UNHEX('DEADBEEF'),b'10101010'),
 (NULL,0.00,'new',NULL,NULL,NULL),
 ('',8.40,'shipped','empty string, not NULL',UNHEX('00FF'),b'1'),
 ('o''brien & co',99.99,'new','quote in the name',NULL,NULL),
 ('multi\nline',5.00,'new','newline in value',NULL,NULL);

CREATE TABLE big (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
                  a VARCHAR(64), b VARCHAR(64), c INT, d DATETIME);
INSERT INTO big (a,b,c,d)
SELECT CONCAT('row-',seq), REPEAT('x',40), seq*7, NOW() FROM seq_1_to_5000;
```
