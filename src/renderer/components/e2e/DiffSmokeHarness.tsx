import React from 'react';

const DiffSmokeHarness: React.FC = () => {
  return (
    <div
      data-testid="e2e-diff-smoke-ready"
      className="flex h-screen w-screen items-center justify-center bg-background"
    >
      <div className="rounded-lg border border-dashed p-8 text-center">
        <h1 className="mb-4 text-xl font-bold">Diff Smoke Harness</h1>
        <p className="text-muted-foreground">
          This test harness needs to be migrated to use the new DiffViewer component.
        </p>
      </div>
    </div>
  );
};

export default DiffSmokeHarness;
