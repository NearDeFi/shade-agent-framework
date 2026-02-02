const PHALA_PPIDS_API_URL = 'https://cloud-api.phala.network/api/v1/attestations/ppids';

const LOCAL_PPID = '00000000000000000000000000000000';

export async function getPpids(isTee) {
  if (!isTee) {
    return [LOCAL_PPID];
  }

  const response = await fetch(PHALA_PPIDS_API_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch PPIDs from Phala API: ${response.status} ${response.statusText}`);
  }

  const ppids = await response.json();
  if (!Array.isArray(ppids)) {
    throw new Error('Phala PPIDs API did not return an array');
  }

  return ppids;
}
