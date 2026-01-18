const BASE_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

async function testFetch() {
    try {
        console.log("Starting PubMed Fetch Test...");
        const searchUrl = `${BASE_URL}/esearch.fcgi?db=pubmed&term=myopia[Title]+AND+(control[Title]+OR+management[Title]+OR+treatment[Title])&retmode=json&retmax=10&sort=date`;
        console.log("Fetching Search URL:", searchUrl);

        // Node 18+ has native fetch. If on older node, this might fail unless polyfilled.
        // 'eyebackend' package.json has "@types/node": "^22.13.4", so user likely has recent Node.
        const searchResponse = await fetch(searchUrl);
        console.log("Search Status:", searchResponse.status);

        if (!searchResponse.ok) {
            throw new Error(`Search Failed: ${searchResponse.statusText}`);
        }

        const searchData = await searchResponse.json() as any;
        console.log("Search Data ID List:", searchData.esearchresult?.idlist);

        const ids = searchData.esearchresult?.idlist || [];
        if (ids.length === 0) {
            console.log("No ID found.");
            return;
        }

        const summaryUrl = `${BASE_URL}/esummary.fcgi?db=pubmed&id=${ids.join(",")}&retmode=json`;
        console.log("Fetching Summary URL:", summaryUrl);

        const summaryResponse = await fetch(summaryUrl);
        console.log("Summary Status:", summaryResponse.status);

        const summaryData = await summaryResponse.json() as any;
        const resObj = summaryData.result || {};
        const firstId = Object.keys(resObj)[0];
        if (firstId && firstId !== 'uids') {
            console.log("First Article Title:", (resObj[firstId] as any)?.title);
        }

        console.log("Test Complete: Success");

    } catch (error) {
        console.error("Test Failed:", error);
    }
}

testFetch();
