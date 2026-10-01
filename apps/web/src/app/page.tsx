import Link from "next/link";

import { buttonVariants } from "@startup/ui";

export default function Home() {
  return (
    <main className="flex flex-1 items-center justify-center px-6 py-24 font-sans">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
          Repo Onboarding
        </h1>
        <p className="text-lg leading-8 text-zinc-600 dark:text-zinc-400">
          Paste a GitHub repository and get a guided walkthrough of the parts
          that matter.
        </p>
        <Link href="/sign-up" className={buttonVariants()}>
          Get Started
        </Link>
      </div>
    </main>
  );
}
