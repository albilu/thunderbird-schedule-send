/* RFC822 transformations preserve the original MIME body and attachment bytes.
 * Loaded in the experiment's sandbox; also exercised directly by Node tests.
 */
var DraftMime = {
  parse(raw) {
    const separator = /\r?\n\r?\n/.exec(raw);
    if (!separator) throw new Error("errorMissingMessage");
    const headers = raw.slice(0, separator.index).split(/\r?\n(?=[^ \t])/)
      .filter(line => /^[!-9;-~]+:/.test(line));
    return { headers, body: raw.slice(separator.index + separator[0].length) };
  },
  get(raw, name) {
    const prefix = `${name.toLowerCase()}:`;
    return this.parse(raw).headers.filter(h => h.toLowerCase().startsWith(prefix))
      .map(h => h.slice(h.indexOf(":") + 1).replace(/\r?\n[ \t]+/g, " ").trim()).join(", ");
  },
  token(job) {
    return encodeURIComponent(JSON.stringify({ version: 1, id: job.id, owner: job.owner,
      rule: job.rule, nextAt: job.nextAt, occurrence: job.occurrence,
      status: job.status, sentCount: job.sentCount }));
  },
  schedule(raw) {
    try {
      const value = JSON.parse(decodeURIComponent(this.get(raw, "X-Scheduled-Send").replace(/\s/g, "")));
      return value.version === 1 && typeof value.id === "string" && typeof value.owner === "string" ? value : null;
    } catch { return null; }
  },
  rewrite(raw, { job, messageId, date, delivery = false }) {
    const parsed = this.parse(raw);
    const remove = /^(?:x-scheduled-send(?:-[^:]*)?|message-id|date):/i;
    const privateHeader = /^(?:bcc|fcc|x-mozilla-[^:]*|x-identity-key|x-account-key|content-length|lines|status):/i;
    const headers = parsed.headers.filter(h => !remove.test(h) && !(delivery && privateHeader.test(h)));
    headers.push(`Message-ID: <${messageId}>`, `Date: ${new Date(date).toUTCString()}`);
    if (job) {
      // Folding keeps long recurrence rules within RFC822 line limits.
      headers.push(`X-Scheduled-Send: ${this.token(job).match(/.{1,72}/g).join("\r\n ")}`);
    }
    return `${headers.join("\r\n")}\r\n\r\n${parsed.body}`;
  }
};
