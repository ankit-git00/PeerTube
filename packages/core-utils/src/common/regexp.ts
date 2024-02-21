export const uuidRegex = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

export function removeFragmentedMP4Ext (path: string) {
  // return path.replace(/-fragmented.mp4$/i, '')
  // return path.replace(/-%d.mp4$/i, '');
    return path.replace(/-%d.ts$/i, '');

}

function removeExt(path: string){
  // return path.replace(/-%d.mp4$/i, '');
  return path.replace(/-%d.ts$/i, '');

}


export function addExt(path : string, i : number){
  // return path.replace(/%d.mp4$/i, `${i}.mp4`);
  return path.replace(/%d.ts$/i, `${i}.ts`);

}
export function addExt2(path : string, i : number){
  // return path.replace(/%d.mp4$/i, `${i}.mp4`);
  return path.replace(/0.ts$/i, `${i}.ts`);

}

export function addExt3(path : string, i : number){
  const regex = /\d+\.ts$/i;

    // Replace the numeric value followed by ".ts" with the new number (i) followed by ".ts"
    return path.replace(regex, `${i}.ts`);

}


export function removeExt2(path : string){
  return path.replace(/-0.ts/i, '');
}