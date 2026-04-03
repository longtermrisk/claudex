export interface SessionRecord {
  threadTs: string;
  channelId: string;
  sessionId: string;
  cwd: string;
  lastResponseTs: string;
  /** Texts sent via slack_send_message to this thread during the last round. */
  lastSentMessages?: string[];
  createdAt: string;
  updatedAt: string;
}
