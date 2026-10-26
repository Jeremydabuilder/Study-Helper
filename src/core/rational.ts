/** Tiny exact rational type, used by problem generators so answers are exact. */
export class Frac {
  constructor(public n: number, public d: number = 1) {
    if (d === 0) throw new Error('zero denominator');
    if (d < 0) { n = -n; d = -d; }
    const g = gcd(Math.abs(n), d) || 1;
    this.n = n / g; this.d = d / g;
  }
  static of(n: number | Frac) { return n instanceof Frac ? n : new Frac(n); }
  add(o: Frac | number) { const b = Frac.of(o); return new Frac(this.n * b.d + b.n * this.d, this.d * b.d); }
  sub(o: Frac | number) { const b = Frac.of(o); return new Frac(this.n * b.d - b.n * this.d, this.d * b.d); }
  mul(o: Frac | number) { const b = Frac.of(o); return new Frac(this.n * b.n, this.d * b.d); }
  div(o: Frac | number) { const b = Frac.of(o); return new Frac(this.n * b.d, this.d * b.n); }
  neg() { return new Frac(-this.n, this.d); }
  eq(o: Frac | number) { const b = Frac.of(o); return this.n === b.n && this.d === b.d; }
  cmp(o: Frac | number) { const b = Frac.of(o); return Math.sign(this.n * b.d - b.n * this.d); }
  num() { return this.n / this.d; }
  isInt() { return this.d === 1; }
  toString() { return this.d === 1 ? String(this.n) : `${this.n}/${this.d}`; }
}
function gcd(a: number, b: number): number { return b === 0 ? a : gcd(b, a % b); }
