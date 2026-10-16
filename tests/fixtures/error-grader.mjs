export function registerGraders(registry) {
  registry.register({
    metadata: {
      name: 'synthetic-error',
      description: 'Model-free operational error control.',
      behavior: {},
      costProfile: 'free',
      determinism: 'static',
      reference: 'reference-free',
      temporalScope: 'trajectory-level',
    },
    async grade() {
      throw new Error('Synthetic grader operational failure.');
    },
  });
}
