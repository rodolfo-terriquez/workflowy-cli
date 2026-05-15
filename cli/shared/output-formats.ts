export interface TsvRow {
  id: string;
  name: string;
  note: string;
  type: string;
  completed: string;
  parent_path: string;
}

function escapeTsv(val: string): string {
  return val.replace(/\t/g, " ").replace(/\n/g, " ");
}

function escapeCsv(val: string): string {
  if (val.includes(",") || val.includes('"') || val.includes("\n")) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

export function formatTsv(rows: TsvRow[]): string {
  const header = "id\tname\tnote\ttype\tcompleted\tparent_path";
  const lines = rows.map((r) =>
    [r.id, r.name, r.note, r.type, r.completed, r.parent_path]
      .map(escapeTsv)
      .join("\t")
  );
  return [header, ...lines].join("\n");
}

export function formatCsv(rows: TsvRow[]): string {
  const header = "id,name,note,type,completed,parent_path";
  const lines = rows.map((r) =>
    [r.id, r.name, r.note, r.type, r.completed, r.parent_path]
      .map(escapeCsv)
      .join(",")
  );
  return [header, ...lines].join("\n");
}
