async function test() {
  const res = await fetch('https://openrouter.ai/api/v1/models');
  const data = await res.json();
  const freeModels = data.data.filter(m => m.pricing.prompt === "0" && m.pricing.completion === "0").map(m => m.id);
  console.log("Free Llama Models: ", freeModels.filter(m => m.includes('llama')));
  console.log("Free Google Models: ", freeModels.filter(m => m.includes('google')));
}
test();
