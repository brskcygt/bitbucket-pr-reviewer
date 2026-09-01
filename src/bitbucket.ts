import axios, { AxiosInstance } from "axios";

export interface PullRequest {
  id: number;
  title: string;
  description: string;
  source: { branch: { name: string }; commit: { hash: string } };
  destination: { branch: { name: string } };
  author: { display_name: string };
  created_on: string;
  updated_on: string;
}

export interface ReviewComment {
  body: string;
  filePath?: string;
  lineNumber?: number;
}

export interface PRComment {
  id: number;
  content: { raw: string };
  parent?: { id: number };
  user: { display_name: string; account_id: string };
  created_on: string;
}

export interface PendingReply {
  thread: PRComment[];      // tüm konuşma zinciri (eskiden yeniye)
  replyTo: PRComment;       // yanıt verilecek son developer yorumu
}

const BOT_MARKER = "<!-- claude-pr-reviewer -->";

export class BitbucketClient {
  private client: AxiosInstance;
  private botAccountId: string | null = null;

  constructor(
    private workspace: string,
    private repoSlug: string,
    username: string,
    apiToken: string
  ) {
    this.client = axios.create({
      baseURL: "https://api.bitbucket.org/2.0",
      auth: { username, password: apiToken },
      headers: { "Content-Type": "application/json" },
    });
  }

  private async getBotAccountId(): Promise<string> {
    if (this.botAccountId) return this.botAccountId;
    const response = await this.client.get("/user");
    this.botAccountId = response.data.account_id as string;
    return this.botAccountId;
  }

  // Açık PR'ların listesini getir
  async getOpenPRs(): Promise<PullRequest[]> {
    const response = await this.client.get(
      `/repositories/${this.workspace}/${this.repoSlug}/pullrequests`,
      { params: { state: "OPEN", pagelen: 50 } }
    );
    return response.data.values as PullRequest[];
  }

  // Bu PR daha önce bot tarafından incelendi mi?
  async isAlreadyReviewed(prId: number): Promise<boolean> {
    const response = await this.client.get(
      `/repositories/${this.workspace}/${this.repoSlug}/pullrequests/${prId}/comments`,
      { params: { pagelen: 50 } }
    );
    const comments: Array<{ content: { raw: string } }> = response.data.values;
    return comments.some((c) => c.content.raw.includes(BOT_MARKER));
  }

  async getFileContent(commitHash: string, filePath: string): Promise<string | null> {
    try {
      const response = await this.client.get(
        `/repositories/${this.workspace}/${this.repoSlug}/src/${commitHash}/${filePath}`,
        { responseType: "text" }
      );
      return response.data as string;
    } catch {
      return null;
    }
  }

  async getPRFileContents(commitHash: string, diff: string): Promise<Record<string, string>> {
    const files = parseDiffFilePaths(diff).slice(0, 10); // en fazla 10 dosya
    const results: Record<string, string> = {};
    for (const filePath of files) {
      const content = await this.getFileContent(commitHash, filePath);
      if (content) {
        // Çok büyük dosyaları kırp
        results[filePath] = content.length > 8000 ? content.slice(0, 8000) + "\n// [dosya kısaltıldı...]" : content;
      }
      await sleep(100);
    }
    return results;
  }

  async getPRDiff(prId: number): Promise<string> {
    // /diff endpoint returns 302 redirect; follow it manually to preserve auth
    const redirect = await this.client.get(
      `/repositories/${this.workspace}/${this.repoSlug}/pullrequests/${prId}/diff`,
      { maxRedirects: 0, validateStatus: (s) => s === 302, responseType: "text" }
    );
    const location = redirect.headers["location"] as string;
    const response = await this.client.get(location, { responseType: "text" });
    return response.data as string;
  }

  async postGeneralComment(prId: number, body: string): Promise<void> {
    // Bot yorumlarını işaretle — tekrar inceleme yapılmasın diye
    await this.client.post(
      `/repositories/${this.workspace}/${this.repoSlug}/pullrequests/${prId}/comments`,
      { content: { raw: `${BOT_MARKER}\n${body}` } }
    );
  }

  async postInlineComment(prId: number, body: string, filePath: string, lineNumber: number): Promise<void> {
    await this.client.post(
      `/repositories/${this.workspace}/${this.repoSlug}/pullrequests/${prId}/comments`,
      {
        content: { raw: `${BOT_MARKER}\n${body}` },
        inline: { to: lineNumber, path: filePath },
      }
    );
  }

  async postReply(prId: number, parentId: number, body: string): Promise<void> {
    await this.client.post(
      `/repositories/${this.workspace}/${this.repoSlug}/pullrequests/${prId}/comments`,
      {
        content: { raw: `${BOT_MARKER}\n${body}` },
        parent: { id: parentId },
      }
    );
  }

  async getPendingReplies(prId: number): Promise<PendingReply[]> {
    const botAccountId = await this.getBotAccountId();

    const response = await this.client.get(
      `/repositories/${this.workspace}/${this.repoSlug}/pullrequests/${prId}/comments`,
      { params: { pagelen: 100 } }
    );
    const comments: PRComment[] = response.data.values;

    const isBot = (c: PRComment) =>
      c.user?.account_id === botAccountId || c.content.raw.includes(BOT_MARKER);

    // parent id → children map
    const childrenMap = new Map<number, PRComment[]>();
    for (const c of comments) {
      if (c.parent) {
        const arr = childrenMap.get(c.parent.id) ?? [];
        arr.push(c);
        childrenMap.set(c.parent.id, arr);
      }
    }

    // Bot'un yazdığı kök yorumları bul (parent'sız veya inline)
    const botRoots = comments.filter((c) => !c.parent && isBot(c));

    const pending: PendingReply[] = [];

    for (const root of botRoots) {
      // Thread'i BFS ile topla, tarihe göre sırala
      const thread: PRComment[] = [root];
      const queue = [...(childrenMap.get(root.id) ?? [])];
      while (queue.length > 0) {
        const c = queue.shift()!;
        thread.push(c);
        queue.push(...(childrenMap.get(c.id) ?? []));
      }
      thread.sort((a, b) => new Date(a.created_on).getTime() - new Date(b.created_on).getTime());

      const last = thread[thread.length - 1];
      // Son yorum bot'tan değilse yanıt bekliyor demektir
      if (!isBot(last)) {
        pending.push({ thread, replyTo: last });
      }
    }

    return pending;
  }

  async postReviewComments(prId: number, comments: ReviewComment[]): Promise<void> {
    for (const comment of comments) {
      try {
        if (comment.filePath && comment.lineNumber) {
          await this.postInlineComment(prId, comment.body, comment.filePath, comment.lineNumber);
        } else {
          await this.postGeneralComment(prId, comment.body);
        }
        await sleep(500); // rate limit
      } catch {
        console.warn(`Inline yorum gönderilemedi (${comment.filePath}:${comment.lineNumber}), genel yorum olarak deneniyor`);
        await this.postGeneralComment(prId, `**\`${comment.filePath}:${comment.lineNumber}\`**\n\n${comment.body}`);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseDiffFilePaths(diff: string): string[] {
  const paths = new Set<string>();
  for (const match of diff.matchAll(/^diff --git a\/.+ b\/(.+)$/gm)) {
    paths.add(match[1]);
  }
  return [...paths];
}
