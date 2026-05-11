export async function wait(seconds):Promise<void> {
  return new Promise(resolve => {
    setTimeout(() => resolve(), seconds * 1000);
  });
}
