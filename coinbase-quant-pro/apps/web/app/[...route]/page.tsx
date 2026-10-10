import { Terminal } from "@/components/terminal";
import { notFound } from "next/navigation";
export default async function Page({
  params,
}: {
  params: Promise<{ route: string[] }>;
}) {
  const { route } = await params;
  if (
    route[0] === "analysis"
      ? route.length !== 2 || !/^[A-Z0-9]+-[A-Z0-9]+$/.test(route[1])
      : route.length !== 1
  )
    notFound();
  if (
    ![
      "dashboard",
      "analysis",
      "markets",
      "backtesting",
      "models",
      "signals",
      "settings",
    ].includes(route[0])
  )
    notFound();
  return (
    <Terminal
      page={route[0]}
      initialProduct={route[0] === "analysis" ? route[1] : undefined}
    />
  );
}
