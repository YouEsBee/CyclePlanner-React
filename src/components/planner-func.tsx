export async function fetchParkConnectors(DATASET_ID:string) {
    const pollRes = await fetch(
        `https://api-open.data.gov.sg/v1/public/api/datasets/${DATASET_ID}/poll-download`
    );
    const pollJson = await pollRes.json();

    if (pollJson.code !== 0) {
        throw new Error(pollJson.errMsg);
    }

    const fileRes = await fetch(pollJson.data.url);
    const geojson = await fileRes.json();
    return geojson;
}