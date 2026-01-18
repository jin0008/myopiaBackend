import express from "express";

const router = express.Router();

// NCBI E-utilities Base URL
const BASE_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

interface PubMedArticle {
    uid: string;
    title: string;
    source: string; // Journal
    pubdate: string;
    epubdate: string;
    authors: { name: string }[];
    sortfirstauthor: string;
    // ... other fields
}

router.get("/", async (req, res) => {
    try {
        console.log("Fetching news from PubMed...");
        // 1. Search for latest articles on Myopia Control within last 6 months (reldate=180)
        const searchUrl = `${BASE_URL}/esearch.fcgi?db=pubmed&term=myopia[Title]+AND+(control[Title]+OR+management[Title]+OR+treatment[Title])&reldate=180&retmode=json&retmax=10&sort=date`;

        const searchResponse = await fetch(searchUrl);
        if (!searchResponse.ok) throw new Error("PubMed Search Failed");

        const searchData = await searchResponse.json() as any;
        const ids = searchData.esearchresult?.idlist || [];

        if (ids.length === 0) {
            res.json([]);
            return;
        }

        // 2. Fetch Details (Abstracts) using efetch (returns XML)
        const fetchUrl = `${BASE_URL}/efetch.fcgi?db=pubmed&id=${ids.join(",")}&retmode=xml`;
        const fetchResponse = await fetch(fetchUrl);
        if (!fetchResponse.ok) throw new Error("PubMed Fetch Failed");
        const xmlText = await fetchResponse.text();

        // 3. Parse XML using Regex (Fallback since fast-xml-parser install failed)
        // Split by article to handle multiple
        // Fix: Explicitly type 'id' as string to resolve TS7006
        const articles = ids.map((id: string) => {
            // Find the block for this ID (PMID)
            // Simple approach: Split by <PubmedArticle> and find the one containing the PMID
            // But PubMed order might match ID order. safely, let's parse all blocks.
            return null;
        });

        // Better Regex Parse Strategy:
        // Match all <PubmedArticle> blocks
        // Fix: Use [\s\S] instead of dotAll /s flag (TS1501)
        const articleBlocks = xmlText.match(/<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g) || [];

        const parsedArticles = articleBlocks.map(block => {
            const getTag = (tag: string) => {
                // Fix: Use [\s\S] instead of s flag
                const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
                return match ? match[1].trim() : "";
            };

            const pmid = getTag("PMID");
            const title = getTag("ArticleTitle");
            const journal = getTag("Title"); // Journal Title
            // Date: simplified extraction from PubDate
            const year = getTag("Year");
            const month = getTag("Month");
            const day = getTag("Day");
            const pubDate = `${year}-${month || '01'}-${day || '01'}`; // ISO-ish

            // Abstract often has multiple AbstractText parts (sections), join them.
            // Fix: Use [\s\S] for multi-line abstract parts
            const abstractMatches = block.match(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g);
            const abstract = abstractMatches
                ? abstractMatches.map(m => m.replace(/<[^>]+>/g, "")).join(" ")
                : "";

            // Author (First author)
            const lastName = getTag("LastName");
            const initials = getTag("Initials");
            const author = lastName && initials ? `${lastName} ${initials}` : "Unknown Author";

            if (!pmid || !title) return null;

            return {
                id: pmid,
                title: title.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"), // Decode minimal entities
                journal: journal.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"),
                date: pubDate,
                author: author,
                abstract: abstract.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"),
                url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`
            };
        }).filter(a => a !== null);

        res.json(parsedArticles);

    } catch (error) {
        console.error("News Fetch Error:", error);
        res.status(500).json({ error: "Failed to fetch news" });
    }
});

export default router;
