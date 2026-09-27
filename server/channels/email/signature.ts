import sanitizeHtml from "sanitize-html";

const ALLOWED_TAGS=["p","div","span","br","strong","b","em","i","table","tbody","tr","td","a","img"];
const ALLOWED_ATTRIBUTES:Record<string,string[]>={
  "*":["style","title"],
  a:["href","target","rel","title","style"],
  img:["src","alt","title","width","height","style"],
  table:["width","height","style"],
  td:["width","height","style"],
};

export function sanitizeEmailSignatureHtml(value:string):string {
  return sanitizeHtml(value??"",{
    allowedTags:ALLOWED_TAGS,
    allowedAttributes:ALLOWED_ATTRIBUTES,
    allowedSchemes:["http","https","mailto","cid"],
    allowedSchemesByTag:{img:["http","https","cid"],a:["http","https","mailto"]},
    allowProtocolRelative:false,
    disallowedTagsMode:"discard",
    allowedStyles:{
      "*":{
        color:[/^#[0-9a-f]{3,8}$/i,/^rgba?\([\d\s,.%]+\)$/i,/^[a-z]{3,20}$/i],
        "background-color":[/^#[0-9a-f]{3,8}$/i,/^rgba?\([\d\s,.%]+\)$/i,/^[a-z]{3,20}$/i],
        "font-family":[/^[\w\s,'"-]{1,120}$/],
        "font-size":[/^\d+(?:\.\d+)?(?:px|pt|em|rem|%)$/],
        "font-weight":[/^(?:normal|bold|[1-9]00)$/],
        "font-style":[/^(?:normal|italic)$/],
        "text-decoration":[/^(?:none|underline)$/],
        "text-align":[/^(?:left|right|center)$/],
        "line-height":[/^\d+(?:\.\d+)?(?:px|pt|em|rem|%)?$/],
        margin:[/^[-\d.\s]+(?:px|pt|em|rem|%)?(?:\s+[-\d.]+(?:px|pt|em|rem|%)?){0,3}$/],
        padding:[/^[-\d.\s]+(?:px|pt|em|rem|%)?(?:\s+[-\d.]+(?:px|pt|em|rem|%)?){0,3}$/],
        width:[/^\d+(?:\.\d+)?(?:px|pt|em|rem|%)$/],
        height:[/^\d+(?:\.\d+)?(?:px|pt|em|rem|%)$/],
        "max-width":[/^\d+(?:\.\d+)?(?:px|pt|em|rem|%)$/],
        "vertical-align":[/^(?:top|middle|bottom|baseline)$/],
        "border-collapse":[/^collapse$/],
      },
    },
    transformTags:{
      a:(tagName,attribs)=>({tagName,attribs:{...attribs,...(attribs.target==="_blank"?{rel:"noopener noreferrer"}:{})}}),
    },
  }).trim();
}

function escapeHtml(value:string) {
  return value.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

export function signatureTextFromHtml(value:string):string {
  const sanitized=sanitizeEmailSignatureHtml(value);
  const spaced=sanitized
    .replace(/<br\s*\/?>/gi,"\n")
    .replace(/<\/(?:p|div|tr)>/gi,"\n")
    .replace(/<\/td>/gi,"\t");
  return sanitizeHtml(spaced,{allowedTags:[],allowedAttributes:{}})
    .replace(/\u00a0/g," ").replace(/[ \t]+\n/g,"\n").replace(/\n{3,}/g,"\n\n").trim();
}

export function buildEmailBodies(reply:string,signatureEnabled:boolean,signatureHtml:string|undefined) {
  const cleanSignature=signatureEnabled?sanitizeEmailSignatureHtml(signatureHtml??""):"";
  const replyHtml=escapeHtml(reply).replace(/\r?\n/g,"<br>");
  const signatureText=cleanSignature?signatureTextFromHtml(cleanSignature):"";
  return {
    text:signatureText?`${reply}\n\n${signatureText}`:reply,
    html:cleanSignature?`${replyHtml}<br><br>${cleanSignature}`:replyHtml,
  };
}
