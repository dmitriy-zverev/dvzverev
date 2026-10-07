export const DELIVERY_SNAPSHOT = `WITH ranked_deliveries AS (
  SELECT d.*, ROW_NUMBER() OVER (
    PARTITION BY edition_id, destination_id
    ORDER BY CASE WHEN failure_reason = 'generation_exhausted' THEN 1 ELSE 0 END,
             updated_at DESC, delivery_id ASC
  ) AS delivery_rank FROM deliveries d
), current_deliveries AS (
  SELECT * FROM ranked_deliveries WHERE delivery_rank = 1
)`;
