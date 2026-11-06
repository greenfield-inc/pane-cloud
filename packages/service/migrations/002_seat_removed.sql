-- When the owner's seat was removed from their team (D-27). While set, the owner has no seat: the
-- machine was stopped with its disk kept, and it starts once more for a 60-minute push window.
-- It is cleared when the owner takes a seat again. The seat row itself is deleted on removal, so
-- this time can't be read from anywhere else.
ALTER TABLE machines ADD COLUMN seat_removed_at timestamptz;
