-- Atomic dedup lock for classify-response.
--
-- The classify-response edge function inserts a placeholder row with
-- classification = 'processing' the moment it starts handling an inbound
-- message, before its 45-second human-delay window. This partial unique index
-- guarantees that only ONE in-flight 'processing' row can exist per phone at a
-- time: a second webhook that fires during the delay window hits a unique
-- constraint violation on its insert and bails out, so a customer never gets
-- two auto-replies from overlapping webhook deliveries.
--
-- The lock releases when the handler promotes the row to its real
-- classification (positive/negative/gray/unclear) at the end of processing.
-- Duplicates that arrive after promotion are caught separately by the 24h
-- recent-reply check in the function.
create unique index if not exists responses_processing_lock_uidx
  on public.responses (phone)
  where classification = 'processing';
