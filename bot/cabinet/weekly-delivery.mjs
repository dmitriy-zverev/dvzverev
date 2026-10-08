import { openCabinetDb, withTransaction, bumpDataVersion } from './db.mjs';
import { formatVkPost } from '../content.mjs';

// Delayed VK posts belong to VK, so the regular worker must never send them again.
export async function weeklyDelivery(config, slot, now, fetcher = fetch, env = process.env) {
  const db = openCabinetDb(env);
  try {
    const row = db
      .prepare(
        `SELECT w.*,s.edition_id,s.slot_utc FROM schedule_slots s
      LEFT JOIN vk_weekly_posts w USING(plan_id)
      WHERE s.project_id=? AND s.destination_id=? AND s.slot_key=?`,
      )
      .get(config.projectId, config.destinationIds[0], slot);
    if (!row?.post_id || !['deferred', 'scheduled', 'sent'].includes(row.status))
      return { status: row?.status === 'uncertain' ? 'uncertain' : 'weekly_preparation_required' };
    let sent = row.status === 'sent';
    if (!sent) {
      const response = await fetcher('https://api.vk.com/method/wall.getById', {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
        body: new URLSearchParams({
          access_token: config.vkToken,
          v: '5.199',
          posts: `-${row.group_id}_${row.post_id}`,
        }),
      });
      const data = await response.json();
      const vkCode = data.error?.error_code;
      // Community tokens often cannot wall.get* (15/27). After slot time, trust publish_date.
      if (!response.ok || data.error) {
        if (
          (vkCode === 15 || vkCode === 27) &&
          Date.parse(row.slot_utc) <= now.getTime()
        ) {
          sent = true;
        } else if (vkCode === 15 || vkCode === 27) {
          return { status: 'vk_scheduled' };
        } else {
          throw new Error('vk_weekly_publication_check_failed');
        }
      } else {
        const post = Array.isArray(data.response) ? data.response[0] : data.response?.items?.[0];
        sent =
          post?.id === row.post_id &&
          post.owner_id === -Number(row.group_id) &&
          post.post_type === 'post' &&
          post.date * 1000 <= now.getTime();
      }
      if (!sent) return { status: 'vk_scheduled' };
      withTransaction(db, () => {
        db.prepare("UPDATE vk_weekly_posts SET status='sent',updated_at=? WHERE plan_id=?").run(
          now.toISOString(),
          row.plan_id,
        );
        db.prepare(
          "UPDATE deliveries SET status='sent',sent_at=?,updated_at=? WHERE edition_id=?",
        ).run(now.toISOString(), now.toISOString(), row.edition_id);
        db.prepare(
          "UPDATE editions SET aggregate_status='sent',updated_at=? WHERE edition_id=?",
        ).run(now.toISOString(), row.edition_id);
        db.prepare("UPDATE schedule_slots SET plan_status='sent',updated_at=? WHERE plan_id=?").run(
          now.toISOString(),
          row.plan_id,
        );
        bumpDataVersion(db);
      });
    }
    const content = row.post_json ? JSON.parse(row.post_json) : null;
    const text = content ? formatVkPost(content) : '';
    return {
      status: 'sent',
      entry: {
        slot,
        platform: 'vk',
        status: 'sent',
        postId: content?.id || row.edition_id,
        vkText: text,
        image: {
          status: 'ready',
          text,
          vk: { status: 'ready', attachment: row.attachment },
        },
        ...(content?.generation ? { generation: content.generation } : {}),
        vkGroupId: String(row.group_id),
        vkPostId: row.post_id,
        attempts: 1,
        createdAt: row.updated_at,
        sentAt: now.toISOString(),
      },
    };
  } finally {
    db.close();
  }
}
