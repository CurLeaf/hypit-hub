import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/** Official-style production layout: authors/, runs/, recipes/, assets/ */
export type ProductionLayout = {
  readonly productionDir: string;
  readonly authorsDir: string;
  readonly runsDir: string;
  readonly assetsDir: string;
  readonly recipesPath: string;
  readonly authorPath: string;
  readonly runPath: string;
};

export async function ensureProductionLayout(productionDir: string): Promise<ProductionLayout> {
  const authorsDir = join(productionDir, "authors");
  const runsDir = join(productionDir, "runs");
  const assetsDir = join(productionDir, "assets");
  await mkdir(authorsDir, { recursive: true });
  await mkdir(runsDir, { recursive: true });
  await mkdir(assetsDir, { recursive: true });
  return {
    productionDir,
    authorsDir,
    runsDir,
    assetsDir,
    recipesPath: join(productionDir, "recipes.svs"),
    authorPath: join(authorsDir, "main.svml"),
    runPath: join(runsDir, "final.svrun"),
  };
}

export function runMarkup(authorRelativePath: string): string {
  return `<?svml using="@hypit/run-markup@1"?>

<svrun version="1">
  <author source="${authorRelativePath}"/>
  <target output="final.video"/>
</svrun>
`;
}
