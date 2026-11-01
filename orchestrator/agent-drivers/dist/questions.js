export const askOpened = (prefix, sessionId, requestId, request) => {
    const question = request.tool_name === 'AskUserQuestion';
    return {
        type: 'request/opened', id: `${prefix}:${sessionId}:${requestId}`, kind: question ? 'question' : 'permission',
        tool: request.tool_name,
        reason: question
            ? (request.input?.questions ?? []).map(item => item.question).join('\n')
            : request.description ?? request.input?.description ?? request.input?.command ?? `${request.display_name ?? request.tool_name} requests permission`,
        ...(question ? { detail: { questions: (request.input?.questions ?? []).map((item, index) => ({ id: `q${index}`, question: item.question, header: item.header,
                    ...(item.options ? { options: item.options } : {}), ...(item.multiSelect === undefined ? {} : { multiSelect: item.multiSelect }) })) } }
            : { detail: { input: request.input } }),
    };
};
export function askAnswers(questions, value) {
    let answers;
    if (questions.length === 1)
        answers = { [questions[0].question]: String(value ?? '').trim() };
    else {
        try {
            answers = JSON.parse(value);
        }
        catch {
            throw new Error('Answer each question using the form');
        }
        if (!answers || typeof answers !== 'object' || Array.isArray(answers))
            throw new Error('Answer each question using the form');
    }
    const answerOf = (item, index) => String(answers?.[`q${index}`] ?? answers?.[item.question] ?? '').trim();
    if (questions.some((item, index) => answerOf(item, index) === ''))
        throw new Error('Answer every question first');
    return Object.fromEntries(questions.map((item, index) => [item.question, answerOf(item, index)]));
}
