export interface SessionRecord {
  threadTs: string;
  channelId: string;
  sessionId: string;
  cwd: string;
  lastResponseTs: string;
  /** Texts sent via slack_send_message during the previous turn, to re-anchor context. */
  lastSentMessages?: string[];
  createdAt: string;
  updatedAt: string;
}
