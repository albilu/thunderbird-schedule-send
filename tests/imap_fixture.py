"""Loopback-only IMAP fixture for native Thunderbird tests. Never relays mail."""
from datetime import datetime, timezone
import re
import socketserver
import threading


class IMAPServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self):
        super().__init__(("127.0.0.1", 0), IMAPHandler)
        self.lock = threading.RLock()
        self.mailboxes = {name: [] for name in ["INBOX", "Drafts", "Sent", "Trash"]}
        self.next_uid = 1
        self.commands = []
        self.errors = []

    def append(self, folder, raw, flags=None):
        with self.lock:
            message = {"uid": self.next_uid, "raw": raw, "flags": set(flags or [])}
            self.next_uid += 1
            self.mailboxes.setdefault(folder, []).append(message)
            return message

    def replace(self, uid, raw):
        """Emulate another mail client replacing an IMAP draft."""
        with self.lock:
            for folder, messages in self.mailboxes.items():
                for message in messages[:]:
                    if message["uid"] == uid:
                        messages.remove(message)
                        return self.append(folder, raw, message["flags"])
        raise KeyError(uid)


class IMAPHandler(socketserver.StreamRequestHandler):
    capabilities = "IMAP4rev1 UIDPLUS MOVE NAMESPACE"

    def line(self, text):
        self.wfile.write(text.encode() + b"\r\n")
        self.wfile.flush()

    def notify(self):
        if not self.selected:
            return
        messages = self.server.mailboxes[self.selected]
        uids = [m["uid"] for m in messages]
        for index in range(len(self.known) - 1, -1, -1):
            if self.known[index] not in uids:
                self.line(f"* {index + 1} EXPUNGE")
                self.known.pop(index)
        if self.known != uids:
            self.line(f"* {len(messages)} EXISTS")
            self.known = uids

    @staticmethod
    def tokens(text):
        return re.findall(r'"(?:\\.|[^"\\])*"|\([^)]*\)|[^\s]+', text)

    @staticmethod
    def unquote(value):
        return value[1:-1].replace('\\"', '"').replace('\\\\', '\\') if value.startswith('"') else value

    def matching(self, sequence, uid):
        messages = self.server.mailboxes[self.selected]
        maximum = max((m["uid"] for m in messages), default=0) if uid else len(messages)
        wanted = set()
        for item in sequence.split(","):
            bounds = [maximum if x == "*" else int(x) for x in item.split(":")]
            wanted.update(range(min(bounds), max(bounds) + 1))
        return [(i + 1, m) for i, m in enumerate(messages) if (m["uid"] if uid else i + 1) in wanted]

    def handle(self):
        self.selected = None
        self.known = []
        # PREAUTH avoids credentials and password prompts in the disposable test.
        self.line(f"* PREAUTH [CAPABILITY {self.capabilities}] Local test fixture")
        while data := self.rfile.readline():
            command = data.decode("utf8", errors="replace").rstrip("\r\n")
            if not command:
                continue
            tag, operation, *remaining = command.split(" ", 2)
            args = remaining[0] if remaining else ""
            operation = operation.upper()
            self.server.commands.append(command)
            literal = None
            if operation == "APPEND":
                match = re.search(r"\{(\d+)(\+)?\}$", args)
                if not match:
                    self.line(f"{tag} BAD missing literal")
                    continue
                if not match[2]:
                    self.line("+ Send message")
                literal = self.rfile.read(int(match[1]))
                self.rfile.readline()
            try:
                with self.server.lock:
                    uid_mode = operation == "UID"
                    if uid_mode:
                        operation, _, args = args.partition(" ")
                        operation = operation.upper()
                    tokens = self.tokens(args)
                    response = "OK completed"
                    if operation == "CAPABILITY":
                        self.line(f"* CAPABILITY {self.capabilities}")
                    elif operation == "NAMESPACE":
                        self.line('* NAMESPACE (("" "/")) NIL NIL')
                    elif operation in ("LOGIN", "AUTHENTICATE", "SUBSCRIBE", "UNSUBSCRIBE", "CHECK", "ID"):
                        if operation == "ID":
                            self.line("* ID NIL")
                    elif operation in ("LIST", "LSUB"):
                        pattern = self.unquote(tokens[-1]) if tokens else "*"
                        for folder in self.server.mailboxes:
                            if pattern not in ("*", "%") and folder != pattern:
                                continue
                            special = {"Drafts": " \\Drafts", "Sent": " \\Sent", "Trash": " \\Trash"}.get(folder, "")
                            self.line(f'* {operation} (\\HasNoChildren{special}) "/" "{folder}"')
                    elif operation in ("SELECT", "EXAMINE"):
                        self.selected = self.unquote(tokens[0])
                        messages = self.server.mailboxes[self.selected]
                        self.known = [m["uid"] for m in messages]
                        self.line("* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)")
                        self.line("* OK [PERMANENTFLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft \\*)] flags")
                        self.line(f"* {len(messages)} EXISTS")
                        self.line("* 0 RECENT")
                        self.line("* OK [UIDVALIDITY 1] validity")
                        self.line(f"* OK [UIDNEXT {self.server.next_uid}] next")
                        response = "OK [READ-WRITE] selected"
                    elif operation == "STATUS":
                        folder = self.unquote(tokens[0])
                        messages = self.server.mailboxes[folder]
                        values = {"MESSAGES": len(messages), "RECENT": 0, "UIDNEXT": self.server.next_uid,
                                  "UIDVALIDITY": 1, "UNSEEN": sum('\\Seen' not in m["flags"] for m in messages)}
                        fields = " ".join(f"{key} {values.get(key, 0)}" for key in tokens[1].strip("()").upper().split())
                        self.line(f'* STATUS "{folder}" ({fields})')
                    elif operation == "CREATE":
                        self.server.mailboxes.setdefault(self.unquote(tokens[0]), [])
                    elif operation == "APPEND":
                        folder = self.unquote(tokens[0])
                        flags = next((t.strip("()").split() for t in tokens[1:] if t.startswith("(")), [])
                        message = self.server.append(folder, literal, flags)
                        if self.selected == folder:
                            self.notify()
                        response = f"OK [APPENDUID 1 {message['uid']}] appended"
                    elif operation == "FETCH":
                        self.notify()
                        for sequence, message in self.matching(tokens[0], uid_mode):
                            raw = message["raw"]
                            fields = [f"UID {message['uid']}", f"FLAGS ({' '.join(sorted(message['flags']))})", f"RFC822.SIZE {len(raw)}"]
                            if "INTERNALDATE" in args.upper():
                                fields.append('INTERNALDATE "24-Oct-2026 12:00:00 +0000"')
                            body = re.search(r"BODY(?:\.PEEK)?\[([^\]]*)\](?:<(\d+)(?:\.(\d+))?>)?", args, re.I)
                            if body:
                                section = body[1]
                                block = raw
                                if section.upper().startswith("HEADER"):
                                    block = re.split(br"\r?\n\r?\n", raw, maxsplit=1)[0] + b"\r\n\r\n"
                                    requested = re.search(r"HEADER.FIELDS\s*\(([^)]*)\)", section, re.I)
                                    if requested:
                                        names = requested[1].lower().split()
                                        lines = re.split(br"\r?\n(?=[^ \t])", block.strip())
                                        block = b"\r\n".join(h for h in lines if h.split(b":", 1)[0].decode().lower() in names) + b"\r\n\r\n"
                                elif section.upper() == "TEXT":
                                    block = re.split(br"\r?\n\r?\n", raw, maxsplit=1)[1]
                                partial = ""
                                if body[2]:
                                    start = int(body[2]); length = int(body[3] or len(block))
                                    block = block[start:start + length]
                                    partial = f"<{start}>"
                                self.wfile.write(f"* {sequence} FETCH ({' '.join(fields)} BODY[{section}]{partial} {{{len(block)}}}\r\n".encode() + block + b")\r\n")
                                self.wfile.flush()
                            else:
                                self.line(f"* {sequence} FETCH ({' '.join(fields)})")
                    elif operation == "SEARCH":
                        self.notify()
                        matches = []
                        for sequence, message in enumerate(self.server.mailboxes[self.selected], 1):
                            if "UNDELETED" in args.upper() and "\\Deleted" in message["flags"]:
                                continue
                            header_query = re.search(r'HEADER\s+([^ ]+)\s+("[^"]*"|[^ ]+)', args, re.I)
                            if header_query:
                                wanted = self.unquote(header_query[2]).encode().lower()
                                header = re.search(rb"^" + header_query[1].encode() + rb":([^\r\n]*)", message["raw"], re.M | re.I)
                                if not header or wanted not in header[1].lower():
                                    continue
                            matches.append(str(message["uid"] if uid_mode else sequence))
                        self.line("* SEARCH " + " ".join(matches))
                    elif operation == "STORE":
                        flags = set(" ".join(tokens[2:]).strip("()").split())
                        for sequence, message in self.matching(tokens[0], uid_mode):
                            if tokens[1].startswith("+"):
                                message["flags"].update(flags)
                            elif tokens[1].startswith("-"):
                                message["flags"].difference_update(flags)
                            else:
                                message["flags"] = flags.copy()
                            if ".SILENT" not in tokens[1].upper():
                                self.line(f"* {sequence} FETCH (UID {message['uid']} FLAGS ({' '.join(sorted(message['flags']))}))")
                    elif operation in ("COPY", "MOVE"):
                        source = self.matching(tokens[0], uid_mode)
                        folder = self.unquote(tokens[1])
                        copied = [self.server.append(folder, m["raw"], m["flags"]) for _, m in source]
                        if operation == "MOVE":
                            for _, message in source:
                                self.server.mailboxes[self.selected].remove(message)
                            self.notify()
                        response = f"OK [COPYUID 1 {','.join(str(m['uid']) for _, m in source)} {','.join(str(m['uid']) for m in copied)}] copied"
                    elif operation in ("EXPUNGE", "CLOSE"):
                        candidates = self.matching(tokens[0], True) if uid_mode else list(enumerate(self.server.mailboxes[self.selected], 1))
                        for _, message in candidates:
                            if "\\Deleted" in message["flags"]:
                                self.server.mailboxes[self.selected].remove(message)
                        if operation == "CLOSE":
                            self.selected = None; self.known = []
                        else:
                            self.notify()
                    elif operation == "NOOP":
                        self.notify()
                    elif operation == "LOGOUT":
                        self.line("* BYE closing")
                        self.line(f"{tag} OK logout")
                        return
                    else:
                        self.server.errors.append(f"Unsupported: {command}")
                        response = "BAD unsupported command"
                    self.line(f"{tag} {response}")
            except (BrokenPipeError, ConnectionResetError):
                return
            except Exception as error:
                self.server.errors.append(f"{command}: {error!r}")
                self.line(f"{tag} BAD fixture error")
