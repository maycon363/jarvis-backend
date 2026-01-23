const axios = require("axios");
const { format, isToday, isTomorrow, parseISO, isThisWeek, isValid} = require("date-fns");
const { ptBR } = require("date-fns/locale");

const gerarPromptBase = require("./jarvis.prompt");
const {salvarNoHistorico, salvarCompromisso, listarCompromissos, obterHistorico} = require("../services/memory.service");

const { GROQ_API_KEY } = require("../config/env");

function formatarDataExtenso(dataISO) {
    if (!dataISO) return "em data indefinida";

    const data = typeof dataISO === "string" ? parseISO(dataISO) : dataISO;
    if (!isValid(data)) return "em uma data a confirmar";

    const hora = format(data, "HH:mm");

    if (isToday(data)) return `hoje, às ${hora}`;
    if (isTomorrow(data)) return `amanhã, às ${hora}`;

    if (isThisWeek(data, { weekStartsOn: 1 })) {
        const diaSemana = format(data, "eeee", { locale: ptBR });
        return `este ${diaSemana}, às ${hora}`;
    }

    return `no dia ${format(data, "dd 'de' MMMM", {
        locale: ptBR
    })}, às ${hora}`;
}

module.exports = async function jarvisLLM({pergunta, climaContexto, agora}) {
    try {
        const historico = await obterHistorico(80);

        const mensagens = [
            gerarPromptBase({ agora, climaContexto }),
            ...historico.map(m => ({
                role: m.role,
                content: m.content
            })),
            { role: "user", content: pergunta }
        ];

        const tools = [
            {
                type: "function",
                function: {
                    name: "anotar_compromisso",
                    description:
                        "Registra compromissos, notas ou lembretes do usuário.",
                    parameters: {
                        type: "object",
                        properties: {
                            titulo: {
                                type: "string",
                                description: "Título do compromisso"
                            },
                            detalhes: {
                                type: "string",
                                description: "Descrição adicional"
                            },
                            data_evento: {
                                type: "string",
                                description: "Data e hora em ISO 8601"
                            },
                            categoria: {
                                type: "string",
                                enum: ["compromisso", "nota", "lembrete"]
                            }
                        },
                        required: ["titulo", "detalhes"]
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "ver_agenda",
                    description:
                        "Consulta compromissos futuros salvos na agenda."
                }
            }
        ];

        const resGroq = await axios.post(
            "https://api.groq.com/openai/v1/chat/completions",
            {
                model: "llama-3.3-70b-versatile",
                messages: mensagens,
                tools,
                tool_choice: "auto",
                temperature: 0.4
            },
            {
                headers: {
                    Authorization: `Bearer ${GROQ_API_KEY}`,
                    "Content-Type": "application/json"
                },
                timeout: 15000
            }
        );

        const choice = resGroq.data.choices[0].message;
        let respostaFinal = null;

        if (choice.tool_calls?.length) {
            const call = choice.tool_calls[0];
            const args = JSON.parse(call.function.arguments || "{}");

            if (call.function.name === "anotar_compromisso") {
                await salvarCompromisso(
                    args.titulo,
                    args.detalhes,
                    args.data_evento || null,
                    args.categoria || "compromisso"
                );

                respostaFinal = `Com certeza, Senhor. O compromisso "${
                    args.titulo
                }" foi registrado para ${formatarDataExtenso(
                    args.data_evento
                )}.`;
            }

            if (call.function.name === "ver_agenda") {
                const itens = await listarCompromissos();

                if (!itens || itens.length === 0) {
                    respostaFinal =
                        "Senhor, sua agenda está completamente livre no momento.";
                } else {
                    const lista = itens
                        .filter(i => i.data_evento)
                        .sort(
                            (a, b) =>
                                new Date(a.data_evento) -
                                new Date(b.data_evento)
                        )
                        .map(
                            i =>
                                `${formatarDataExtenso(i.data_evento)} — ${
                                    i.titulo
                                }`
                        );

                    respostaFinal =
                        "Senhor, estes são os seus compromissos:\n\n" +
                        lista.join("\n");
                }
            }
        }

        if (!respostaFinal) {
            respostaFinal = (choice.content ||
                "Sistemas operacionais e aguardando suas ordens, Senhor.")
                .replace(/<function=.*?>.*?<\/function>/gs, "")
                .replace(/<\/?[^>]+>/g, "")
                .trim();
        }

        await salvarNoHistorico("user", pergunta);
        await salvarNoHistorico("assistant", respostaFinal);

        return {
            type: "message",
            payload: respostaFinal
        };
    } catch (err) {
        console.error("❌ Erro JARVIS:", err.message);
        return {
            type: "message",
            payload:
                "Perdoe-me, Senhor. Detectei uma instabilidade temporária nos meus sistemas. Já estou corrigindo."
        };
    }
};