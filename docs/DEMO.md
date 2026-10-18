# 5-minute demo script

**Before you start:**

- Open the live URL 5 minutes early, because Render's free tier sleeps.
- Run `npm run seed` once, against the same Neon database as the live site.
- Log in on two browsers (or one normal window and one incognito window):
  - **A**: `owner@sunrise.demo`
  - **B**: `ayesha@sunrise.demo`

  The password for both is `Demo@12345`.
- In A, go to **Assignment rules**, click **Use demo timings (30s)**, then **Save rules**.

## 1. A lead can never be lost (2 min)
1. In B, open **Team** (or use the top bar) and make sure Ayesha is **Available**.
2. On your phone, open the public form. You can find it under **Workspace & web form → Open**. Submit it as a "customer".
3. Both browsers show the new lead **without refreshing**: a toast, the bell and the list. The lead page shows the **countdown** and its single owner.
4. Do nothing. After 30 seconds, the lead **escalates automatically** to the next available employee. You will see:
   - an assignment history row, *"Not acknowledged by … within the window"*;
   - a **Telegram alert** to the new owner, if they linked Telegram;
   - an entry in **Audit log** (filter "lead"): `lead.escalated` by **System**, with before and after values.
5. The new owner clicks **Acknowledge**. On the **Dashboard**, the "Avg. time to first response" figure updates.
6. In B, set your status to **On leave**. A toast confirms that your unacknowledged leads were **reassigned immediately**.
7. Open **Recovery queue**: it lists leads that escalated twice or are idle, with the reason for each.

## 2. Real integrations (2 min)
1. **WhatsApp:**
   - From a phone that has joined the sandbox, send *"Hi, I need a quote"*. A new contact and lead appear.
   - Reply from the **Inbox**. The phone receives it, and the message status changes from Sent to Delivered.
   - Send **STOP** from the phone. The composer is replaced with an opt-out explanation.
2. **Stripe:**
   - On an opportunity, click **Request payment**, then **Open checkout**, and pay with `4242 4242 4242 4242`.
   - The status turns **Paid** without a refresh, and "Payments received this month" increases.
   - Refund it in the Stripe Dashboard. The status turns **Refunded**.
3. **Google Calendar:**
   - On a contact, click **Book appointment**. The busy times are read from the real calendar.
   - Book it, then show the event in Google Calendar.
   - Reschedule it, then cancel it. Both changes reach Google and appear in the timeline.
4. **Integrations → Synchronization history:** every webhook and outbound call is listed. Point out the `duplicate` and `rejected` rows if any appear.

## 3. Control and safety (1 min)
1. **Pipelines & fields:**
   - Add a custom field. It appears on forms immediately.
   - Show that the **Installations** pipeline has different fields from **Sales**.
2. **Opportunities board:** drag a card to **Design & quote**. The move is blocked until **Roof size** is filled in.
3. **Roles & permissions:**
   - Log in as `omar@sunrise.demo` (Junior). Values show as **Hidden** everywhere, including the CSV export.
   - Omar does not see Audit log in the menu. Calling `/api/audit` directly returns **403**.
4. **Audit log:** the history is read-only. Mention that even direct SQL `UPDATE`/`DELETE` statements are blocked by a database trigger.
5. Optional, for technical judges: run `npm test` (65 automated checks). They include forged and duplicate webhooks and 4 concurrent workers escalating the same lead exactly once.
