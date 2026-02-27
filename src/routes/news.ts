import express from "express";

const router = express.Router();

// NCBI E-utilities Base URL
const BASE_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

type CachedArticle = {
  id: string;
  title: string;
  journal: string;
  date: string;
  author: string;
  abstract: string;
  url: string;
};

let cache: CachedArticle[] | null = null;

async function fetchFromPubMed(): Promise<CachedArticle[]> {
  console.log("Fetching news from PubMed...");
  // 1. Search for latest articles on Myopia Control within last 6 months (reldate=180)
  const searchUrl = `${BASE_URL}/esearch.fcgi?db=pubmed&term=myopia[Title]+AND+(control[Title]+OR+management[Title]+OR+treatment[Title])&reldate=180&retmode=json&retmax=10&sort=date`;

  const searchResponse = await fetch(searchUrl);
  if (!searchResponse.ok) throw new Error("PubMed Search Failed");

  const searchData = (await searchResponse.json()) as {
    esearchresult?: { idlist?: string[] };
  };
  const ids = searchData.esearchresult?.idlist || [];

  if (ids.length === 0) {
    return [];
  }

  // 2. Fetch Details (Abstracts) using efetch (returns XML)
  const fetchUrl = `${BASE_URL}/efetch.fcgi?db=pubmed&id=${ids.join(",")}&retmode=xml`;
  const fetchResponse = await fetch(fetchUrl);
  if (!fetchResponse.ok) throw new Error("PubMed Fetch Failed");
  const xmlText = await fetchResponse.text();

  const articleBlocks =
    xmlText.match(/<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g) || [];

  const parsedArticles = articleBlocks
    .map((block) => {
      const getTag = (tag: string) => {
        const match = block.match(
          new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`),
        );
        return match ? match[1].trim() : "";
      };

      const pmid = getTag("PMID");
      const title = getTag("ArticleTitle");
      const journal = getTag("Title");
      const year = getTag("Year");
      const month = getTag("Month");
      const day = getTag("Day");
      const pubDate = `${year}-${month || "01"}-${day || "01"}`;

      const abstractMatches = block.match(
        /<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g,
      );
      const abstract = abstractMatches
        ? abstractMatches.map((m) => m.replace(/<[^>]+>/g, "")).join(" ")
        : "";

      const lastName = getTag("LastName");
      const initials = getTag("Initials");
      const author =
        lastName && initials ? `${lastName} ${initials}` : "Unknown Author";

      if (!pmid || !title) return null;

      const decode = (s: string) =>
        s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
      return {
        id: pmid,
        title: decode(title),
        journal: decode(journal),
        date: pubDate,
        author: author,
        abstract: decode(abstract),
        url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      };
    })
    .filter((a): a is CachedArticle => a !== null);

  return parsedArticles;
}

async function refreshCache(): Promise<void> {
  try {
    const articles = await fetchFromPubMed();
    cache = articles;
    console.log(`News cache refreshed: ${articles.length} articles`);
  } catch (error) {
    console.error("News cache refresh error:", error);
    // Keep existing cache on error
  }
}
// Populate cache at startup
refreshCache();

// Refresh cache every REFRESH_INTERVAL_MS
setInterval(refreshCache, REFRESH_INTERVAL_MS);

router.get("/", async (req, res) => {
  res.json(cache);
});

export default router;
