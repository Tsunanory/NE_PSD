export const equalBinding = (actual: unknown, expected: unknown) => JSON.stringify(actual) === JSON.stringify(expected);
export const assertBinding = (actual: unknown, expected: unknown, code = 'MODEL_RESPONSE_BINDING_MISMATCH') => { if (!equalBinding(actual, expected)) { const error = new Error('model response binding mismatch'); Object.assign(error, { code }); throw error; } };
