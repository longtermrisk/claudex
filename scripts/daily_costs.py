#!/usr/bin/env python3
"""
Daily cost reporter: fetches Anthropic, RunPod, and OpenAI API costs
and posts a summary to Slack.
"""

import os
import json
import urllib.request
import urllib.parse
import urllib.error
from datetime import datetime, timezone, timedelta


SLACK_BOT_TOKEN = os.environ.get("SLACK_BOT_TOKEN", "")
SLACK_CHANNEL = os.environ.get("COST_REPORT_CHANNEL", "C0AQZ46L9GC")  # #daily-cost

ANTHROPIC_ADMIN_KEY = os.environ.get("ANTHROPIC_ADMIN_KEY", "")
RUNPOD_API_KEY = os.environ.get("RUNPOD_API_KEY", "")
OPENAI_ADMIN_KEY = os.environ.get("OPENAI_ADMIN_KEY", "")


def http_get(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        return {"_error": f"HTTP {e.code}", "_body": body}
    except Exception as e:
        return {"_error": str(e)}


def http_post_json(url, payload, headers=None):
    data = json.dumps(payload).encode()
    h = {"Content-Type": "application/json"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, headers=h, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        return {"_error": f"HTTP {e.code}", "_body": body}
    except Exception as e:
        return {"_error": str(e)}


def get_anthropic_cost(date: datetime) -> str:
    """Fetch Anthropic daily cost using Admin API."""
    if not ANTHROPIC_ADMIN_KEY:
        return "⚠️ `ANTHROPIC_ADMIN_KEY` not set"

    start = date.strftime("%Y-%m-%dT00:00:00Z")
    end = (date + timedelta(days=1)).strftime("%Y-%m-%dT00:00:00Z")
    params = urllib.parse.urlencode({
        "starting_at": start,
        "ending_at": end,
        "bucket_width": "1d",
    })
    url = f"https://api.anthropic.com/v1/organizations/cost_report?{params}"
    resp = http_get(url, headers={
        "x-api-key": ANTHROPIC_ADMIN_KEY,
        "anthropic-version": "2023-06-01",
    })

    if "_error" in resp:
        return f"❌ Error: {resp['_error']} — {resp.get('_body', '')[:200]}"

    # Response: { data: [ { start_time, end_time, results: [ {amount_cents, ...} ] } ] }
    buckets = resp.get("data", [])
    if not buckets:
        return "$0.00"

    total_cents = 0.0
    for bucket in buckets:
        for result in bucket.get("results", []):
            # amount is in cents as decimal string or float
            amount = result.get("amount_cents") or result.get("amount", 0)
            try:
                total_cents += float(amount)
            except (TypeError, ValueError):
                pass

    total_usd = total_cents / 100.0
    return f"*${total_usd:,.4f}*"


def get_runpod_cost(date: datetime) -> str:
    """Fetch RunPod daily charges using GraphQL API."""
    if not RUNPOD_API_KEY:
        return "⚠️ `RUNPOD_API_KEY` not set"

    url = f"https://api.runpod.io/graphql?api_key={RUNPOD_API_KEY}"
    query = """
    {
      myself {
        clientBalance
        currentSpendPerHr
        dailyCharges {
          amount
          updatedAt
          podCharges
          serverlessCharges
          diskCharges
          apiCharges
        }
      }
    }
    """
    resp = http_post_json(url, {"query": query})

    if "_error" in resp:
        return f"❌ Error: {resp['_error']} — {resp.get('_body', '')[:200]}"

    if "errors" in resp:
        errs = "; ".join(e.get("message", str(e)) for e in resp["errors"])
        return f"❌ GraphQL error: {errs}"

    myself = (resp.get("data") or {}).get("myself") or {}
    daily_charges = myself.get("dailyCharges") or []

    # Find today's charge record (updatedAt contains the date)
    target_date_str = date.strftime("%Y-%m-%d")
    today_total = 0.0
    found = False

    for charge in daily_charges:
        updated_at = charge.get("updatedAt", "")
        if target_date_str in updated_at:
            try:
                today_total += float(charge.get("amount", 0))
            except (TypeError, ValueError):
                pass
            found = True

    # Fallback: if no match by date, use the most recent entry
    if not found and daily_charges:
        try:
            today_total = float(daily_charges[-1].get("amount", 0))
        except (TypeError, ValueError):
            pass

    balance = myself.get("clientBalance", "N/A")
    spend_per_hr = myself.get("currentSpendPerHr", 0)
    try:
        balance_str = f"${float(balance):,.2f}"
    except (TypeError, ValueError):
        balance_str = str(balance)

    return f"*${today_total:,.4f}* (balance: {balance_str}, current rate: ${spend_per_hr:.4f}/hr)"


def get_openai_cost(date: datetime) -> str:
    """Fetch OpenAI daily cost using Admin API."""
    if not OPENAI_ADMIN_KEY:
        return "⚠️ `OPENAI_ADMIN_KEY` not set"

    # Use unix timestamps
    start_ts = int(date.replace(hour=0, minute=0, second=0, microsecond=0,
                                tzinfo=timezone.utc).timestamp())
    end_ts = start_ts + 86400
    params = urllib.parse.urlencode({
        "start_time": start_ts,
        "end_time": end_ts,
        "bucket_width": "1d",
    })
    url = f"https://api.openai.com/v1/organization/costs?{params}"
    resp = http_get(url, headers={
        "Authorization": f"Bearer {OPENAI_ADMIN_KEY}",
    })

    if "_error" in resp:
        return f"❌ Error: {resp['_error']} — {resp.get('_body', '')[:200]}"

    # Response: { data: [ { results: [ { amount: { value, currency } } ] } ] }
    buckets = resp.get("data", [])
    if not buckets:
        return "$0.00"

    total_usd = 0.0
    for bucket in buckets:
        for result in bucket.get("results", []):
            amount = result.get("amount", {})
            try:
                total_usd += float(amount.get("value", 0))
            except (TypeError, ValueError):
                pass

    return f"*${total_usd:,.4f}*"


def post_to_slack(text: str):
    """Post a message to Slack."""
    if not SLACK_BOT_TOKEN:
        print("ERROR: SLACK_BOT_TOKEN not set")
        return

    payload = {
        "channel": SLACK_CHANNEL,
        "text": text,
        "unfurl_links": False,
    }
    resp = http_post_json(
        "https://slack.com/api/chat.postMessage",
        payload,
        headers={"Authorization": f"Bearer {SLACK_BOT_TOKEN}"},
    )
    if not resp.get("ok"):
        print(f"Slack error: {resp.get('error', resp)}")
    else:
        print("Posted to Slack successfully.")


def main():
    # Report for yesterday (the last complete day)
    now = datetime.now(timezone.utc)
    yesterday = now - timedelta(days=1)
    date_str = yesterday.strftime("%A, %B %-d %Y")

    print(f"Fetching costs for {date_str}...")

    anthropic_cost = get_anthropic_cost(yesterday)
    runpod_cost = get_runpod_cost(yesterday)
    openai_cost = get_openai_cost(yesterday)

    message = (
        f":bar_chart: *Daily API Cost Report — {date_str}*\n\n"
        f"*Anthropic (ClaudeX):* {anthropic_cost}\n"
        f"*RunPod:* {runpod_cost}\n"
        f"*OpenAI:* {openai_cost}\n"
    )

    print(message)
    post_to_slack(message)


if __name__ == "__main__":
    main()
