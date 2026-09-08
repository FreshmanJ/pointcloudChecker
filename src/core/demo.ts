/** Bundled transformer-winding point cloud, loaded only on request. */
export const DEMO_FILENAME = '变压器绕组.ply';

export async function fetchDemoFile(): Promise<File> {
  const response = await fetch(`${import.meta.env.BASE_URL}samples/transformer-winding.ply`);
  if (!response.ok) throw new Error(`PLY: HTTP ${response.status}`);
  return new File([await response.arrayBuffer()], DEMO_FILENAME, { type: 'application/octet-stream' });
}
