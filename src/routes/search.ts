import express from "express";
import prisma from "../lib/prisma";
import { optionalMobileAuth } from "../lib/mobileAuth";
import { authorBlockFilter } from "../lib/blocks";

const router = express.Router();

const PER_SECTION = 10;

function snippet(s: string, q: string, max = 100): string {
  const flat = s.replace(/\s+/g, " ").trim();
  // Open the excerpt near the match so the user can see why it matched.
  const at = flat.toLowerCase().indexOf(q.toLowerCase());
  if (at <= 0) return flat.length > max ? flat.slice(0, max) + "…" : flat;
  const from = Math.max(0, at - 24);
  const cut = flat.slice(from, from + max);
  return (from > 0 ? "…" : "") + cut + (from + max < flat.length ? "…" : "");
}

/**
 * GET /search?q= — one call, several sections.
 *
 * Hospitals are deliberately absent for now: the place data behind the
 * treatment finder comes from Kakao Local, which is currently unavailable, and
 * the internal `hospital` table has no addresses to search by region with. The
 * client renders that section from `hospitalsAvailable: false` rather than
 * showing an empty list that looks like "no hospitals match".
 */
router.get("/search", optionalMobileAuth, async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (q.length < 2) {
    res.json({
      query: q,
      posts: [],
      polls: [],
      columns: [],
      hospitalsAvailable: false,
    });
    return;
  }

  const notBlocked = await authorBlockFilter(req.mobileUser?.sub);
  const like = { contains: q, mode: "insensitive" as const };

  const [posts, polls, columns] = await Promise.all([
    prisma.community_post.findMany({
      where: {
        deleted_at: null,
        ...notBlocked,
        OR: [{ title: like }, { body: like }],
      },
      orderBy: [{ created_at: "desc" }],
      take: PER_SECTION,
    }),
    prisma.poll.findMany({
      where: { deleted_at: null, ...notBlocked, question: like },
      orderBy: [{ created_at: "desc" }],
      take: PER_SECTION,
    }),
    prisma.expert_column.findMany({
      where: { published: true, OR: [{ title: like }, { body: like }] },
      orderBy: [{ published_at: "desc" }],
      take: PER_SECTION,
    }),
  ]);

  res.json({
    query: q,
    posts: posts.map((p) => ({
      id: p.id,
      title: p.title,
      category: p.category,
      excerpt: snippet(p.body, q),
      createdAt: p.created_at.toISOString(),
    })),
    polls: polls.map((p) => ({
      id: p.id,
      question: p.question,
      createdAt: p.created_at.toISOString(),
    })),
    columns: columns.map((c) => ({
      id: c.id,
      slug: c.slug,
      title: c.title,
      emoji: c.thumbnail_emoji,
      excerpt: snippet(c.body, q),
    })),
    hospitalsAvailable: false,
  });
});

export default router;
