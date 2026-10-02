import { createFileRoute } from '@tanstack/react-router';

// Placeholder until T0.5a mounts the moss shell here (A§4.2).
export const Route = createFileRoute('/')({
  component: Home,
});

function Home() {
  return <main className="flex min-h-screen items-center justify-center font-sans text-sm">moss-multi</main>;
}
