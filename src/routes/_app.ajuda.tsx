import { createFileRoute } from "@tanstack/react-router";

import { PageHeader } from "@/components/common/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

export const Route = createFileRoute("/_app/ajuda")({
  head: () => ({
    meta: [
      { title: "Ajuda" },
      {
        name: "description",
        content:
          "Guia rápido de uso do Stefanello: funil, conversas, contatos, atividades, agenda e configurações.",
      },
      { property: "og:title", content: "Ajuda" },
      {
        property: "og:description",
        content:
          "Guia rápido de uso do Stefanello: funil, conversas, contatos, atividades, agenda e configurações.",
      },
      { property: "og:url", content: "https://aceleraflow.lovable.app/ajuda" },
      { name: "twitter:title", content: "Ajuda" },
      {
        name: "twitter:description",
        content:
          "Guia rápido de uso do Stefanello: funil, conversas, contatos, atividades, agenda e configurações.",
      },
    ],
    links: [{ rel: "canonical", href: "https://aceleraflow.lovable.app/ajuda" }],
  }),
  component: AjudaPage,
});

type HelpSection = {
  title: string;
  description: string;
  tips: string[];
};

const helpSections: HelpSection[] = [
  {
    title: "Funil",
    description: "Quadro de negócios organizado por estágio.",
    tips: [
      "Arraste um cartão entre colunas para mudar o estágio do negócio.",
      "Abra um cartão para ver histórico, contato vinculado e próximos passos.",
      "Crie um negócio direto a partir de um contato ou pelo botão de novo negócio.",
    ],
  },
  {
    title: "Conversas",
    description: "Conversas de WhatsApp e e-mail reunidas em um só lugar.",
    tips: [
      "Cada conversa mostra o histórico completo com o contato, independente do canal.",
      "Responda direto pela conversa — a IA pode sugerir ou enviar respostas conforme sua configuração.",
      "Conversas que precisam de atenção humana ficam sinalizadas com um indicador na barra lateral.",
    ],
  },
  {
    title: "Contatos",
    description: "Cadastro central de pessoas que conversam com você.",
    tips: [
      "Busque por nome, telefone ou e-mail.",
      "Veja negócios, atividades e conversas ligados a cada contato na própria página de detalhe.",
      "Contatos duplicados podem ser revisados e mesclados na tela de duplicados.",
    ],
  },
  {
    title: "Atividades",
    description: "Tarefas e lembretes ligados a contatos e negócios.",
    tips: [
      "Marque uma atividade como concluída direto na lista.",
      "Atividades vencidas aparecem destacadas para não passarem despercebidas.",
      "Crie atividades manualmente ou deixe a IA sugerir os próximos passos.",
    ],
  },
  {
    title: "Agenda",
    description: "Calendário de compromissos — disponível conforme o nicho do seu negócio.",
    tips: [
      "Visualize a semana e crie, edite ou cancele compromissos.",
      "Compromissos podem ser vinculados a um contato existente.",
      "Este item só aparece no menu quando o recurso está ativado para a sua empresa.",
    ],
  },
  {
    title: "Configurações",
    description: "Personalização da empresa, integrações e preferências de IA.",
    tips: [
      "Ajuste marca, cores e informações do negócio.",
      "Conecte canais de WhatsApp e e-mail em Integrações.",
      "Configure o comportamento do assistente de IA e as notificações do time.",
    ],
  },
];

function AjudaPage() {
  return (
    <div className="col-span-12 flex flex-col gap-4">
      <PageHeader title="Ajuda" description="Guia rápido de uso do Stefanello" />
      <Card>
        <CardContent className="p-4">
          <Accordion type="single" collapsible className="w-full">
            {helpSections.map((section) => (
              <AccordionItem key={section.title} value={section.title}>
                <AccordionTrigger>{section.title}</AccordionTrigger>
                <AccordionContent>
                  <p className="text-body text-muted-foreground">{section.description}</p>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-body text-foreground">
                    {section.tips.map((tip) => (
                      <li key={tip}>{tip}</li>
                    ))}
                  </ul>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </CardContent>
      </Card>
    </div>
  );
}
