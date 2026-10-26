// Fonction serveur « lire-facture » — reçoit un PDF (base64) et renvoie une lecture structurée via l'API Claude.
// Réservée aux comptes connectés avec le rôle admin ou factures.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MODEL = Deno.env.get("LECTURE_MODEL") || "claude-sonnet-5-5";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["fournisseur", "numero", "date", "type_document", "lignes", "frais", "sous_total", "total", "confiance", "remarques"],
  properties: {
    fournisseur: { type: "string", description: "Nom court du fournisseur (ex. Adfast, Quincaillerie Rabel, Alumico, Portes Standard, Richelieu, Extrudex, Saand, Durapaint)" },
    numero: { type: "string", description: "Numéro de la facture tel qu'imprimé" },
    date: { type: "string", description: "Date de la facture au format AAAA-MM-JJ" },
    date_echeance: { type: ["string", "null"], description: "Date d'échéance AAAA-MM-JJ si présente" },
    bon_commande: { type: ["string", "null"], description: "Numéro de bon de commande du client (PO) si présent" },
    projet_detecte: { type: ["string", "null"], description: "Nom du projet / chantier / job mentionné (ex. ARIE, Saint-Patrice, École Saint-Thomas, Flora). null si aucun." },
    type_document: {
      type: "string",
      enum: ["stock", "direct_projet", "transformation", "service", "proforma", "bon_livraison", "autre"],
      description: "stock = achat de matériel qui entre au magasin ; direct_projet = matériel fabriqué/commandé pour un projet précis (portes finies, vitrage sur mesure, pièces avec tags) ; transformation = peinture, anodisation, soudure sur du matériel fourni par le client ; service = honoraires, installation, main-d'œuvre, approbation de dessins, transport seul ; proforma = pro-forma ou devis ; bon_livraison = bon de livraison / packing slip sans prix ou marqué comme tel ; autre = indéterminé",
    },
    type_justification: { type: "string", description: "Une phrase expliquant le choix du type" },
    adresse_livraison_differente: { type: "boolean", description: "true si l'adresse de livraison n'est pas celle d'Amro Aluminium" },
    devise: { type: "string", enum: ["CAD", "USD"] },
    sous_total: { type: ["number", "null"], description: "Sous-total des marchandises/services avant frais annexes et taxes" },
    frais: {
      type: "array",
      description: "Frais annexes : transport, surcharge carburant, surcharge énergétique, frais minimum, frais environnementaux, manutention",
      items: { type: "object", additionalProperties: false, required: ["libelle", "montant"], properties: { libelle: { type: "string" }, montant: { type: "number" } } },
    },
    taxes: { type: ["number", "null"], description: "Total des taxes (TPS + TVQ)" },
    total: { type: ["number", "null"], description: "Total de la facture taxes incluses" },
    lignes: {
      type: "array",
      description: "Une entrée par ligne de produit ou de service (pas les frais annexes, pas les taxes, pas les sous-totaux)",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["no_ligne", "code", "description", "quantite", "unite", "prix_unitaire", "montant", "nature"],
        properties: {
          no_ligne: { type: "integer" },
          code: { type: ["string", "null"], description: "Code produit du fournisseur tel qu'imprimé (ex. 4551-304, V17062, 6885-000, AMR020). null si absent." },
          description: { type: "string", description: "Description nettoyée, sans retours à la ligne" },
          quantite: { type: "number", description: "Quantité expédiée/facturée (si une colonne Expédié existe, la préférer à Commandé)" },
          unite: { type: "string", description: "Unité telle qu'imprimée : EA, CH, PR, BT, SA, PQT, FL, RL, pi, m, kg, lb, pce…" },
          prix_unitaire: { type: ["number", "null"] },
          montant: { type: ["number", "null"], description: "Montant de la ligne avant taxes" },
          nature: { type: "string", enum: ["produit", "service", "frais"], description: "produit = article physique ; service = main-d'œuvre, peinture, approbation ; frais = transport ou surcharge imprimé comme une ligne" },
          couleur: { type: ["string", "null"], description: "Couleur ou fini si indiqué (ex. Blanc, Noir, Brut, Anodisé clair)" },
          longueur_pi: { type: ["number", "null"], description: "Longueur unitaire en pieds si la ligne vend des longueurs (ex. 24 pour 24 pi)" },
          poids_kg: { type: ["number", "null"], description: "Poids total de la ligne en kg si facturé au poids" },
        },
      },
    },
    confiance: { type: "number", description: "0 à 1 : confiance globale dans la lecture" },
    remarques: { type: "string", description: "Tout ce qui mérite l'attention du vérificateur (lignes ambiguës, totaux qui ne concordent pas, codes illisibles)" },
  },
};

const SYSTEM = `Tu lis des factures de fournisseurs pour Amro Aluminium Inc. (fabricant et installateur de fenêtres et portes en aluminium, Montréal).
Tu extrais les données telles qu'imprimées, sans inventer. Si une information manque, mets null.
Règles :
- Préfère la quantité expédiée à la quantité commandée quand les deux existent.
- Les frais de transport, surcharges (carburant, énergie), frais minimum, frais environnementaux vont dans "frais", pas dans "lignes", sauf s'ils sont imprimés comme une ligne de produit numérotée (alors nature = "frais").
- Les codes produits doivent être recopiés exactement (tirets, zéros, suffixes).
- Une facture de peinture, d'anodisation ou de soudure sur du matériel fourni par le client est une "transformation".
- Une facture d'honoraires, d'installation, de main-d'œuvre ou d'approbation de dessins est un "service".
- Un document intitulé pro-forma, devis, soumission, quotation est "proforma". Un bon de livraison, packing slip, delivery note est "bon_livraison".
- Si la facture nomme un projet, un chantier, un job, un client final (ex. "Projet : ARIE", "Job : École Saint-Thomas", "Saint-Patrice"), mets-le dans projet_detecte. Un numéro de bon de commande qui contient un nom (ex. "RBL 260408-1_Flora") donne aussi le projet (Flora).
- Les montants sont des nombres, sans symbole, point décimal.
Réponds uniquement avec le JSON demandé.`;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "Méthode non permise" });

  // 1. Vérifier l'utilisateur et son rôle
  const auth = req.headers.get("Authorization") || "";
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData?.user) return json(401, { error: "Connexion requise" });
  const role = (userData.user.app_metadata as Record<string, unknown> | undefined)?.role;
  if (role !== "admin" && role !== "factures") return json(403, { error: "Ce compte n'a pas accès à la lecture des factures" });

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json(500, { error: "La clé API Claude (ANTHROPIC_API_KEY) n'est pas configurée dans Supabase (Edge Functions → Secrets)." });

  // 2. Lire le PDF
  let body: { pdf_base64?: string; nom_fichier?: string };
  try { body = await req.json(); } catch { return json(400, { error: "Corps invalide" }); }
  if (!body.pdf_base64) return json(400, { error: "pdf_base64 manquant" });
  if (body.pdf_base64.length > 28_000_000) return json(413, { error: "PDF trop volumineux (max ~20 Mo)" });

  // 3. Appeler Claude
  // Sortie structurée : le modèle doit répondre avec un JSON conforme au schéma (output_config.format).
  const payload = {
    model: MODEL,
    max_tokens: 8000,
    system: SYSTEM,
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
    messages: [{
      role: "user",
      content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: body.pdf_base64 }, title: body.nom_fichier || "facture.pdf" },
        { type: "text", text: "Lis cette facture et renvoie le JSON de lecture (fournisseur, numéro, date, type de document, lignes, frais, totaux, projet détecté, remarques)." },
      ],
    }],
  };
  const t0 = Date.now();
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    return json(502, { error: "Erreur de l'API Claude (" + resp.status + ")", detail: txt.slice(0, 500) });
  }
  const data = await resp.json();
  if (data.stop_reason === "refusal") return json(502, { error: "Claude a refusé de lire ce document", detail: JSON.stringify(data).slice(0, 500) });
  if (data.stop_reason === "max_tokens") return json(502, { error: "Lecture tronquée (document trop long)", detail: "max_tokens atteint" });
  const textBlock = (data.content || []).find((c: { type: string }) => c.type === "text");
  if (!textBlock?.text) return json(502, { error: "Claude n'a pas renvoyé de lecture structurée", detail: JSON.stringify(data).slice(0, 500) });
  let lecture: unknown;
  try { lecture = JSON.parse(textBlock.text); }
  catch { return json(502, { error: "Réponse de Claude illisible (JSON invalide)", detail: textBlock.text.slice(0, 500) }); }

  return json(200, {
    lecture,
    modele: MODEL,
    usage: data.usage,
    duree_ms: Date.now() - t0,
  });
});
